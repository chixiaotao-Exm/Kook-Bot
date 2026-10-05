"""Loopback HTTPS CONNECT bridge to one authenticated SOCKS5 session.

Each instance replaces the provider's SID once. All browser connections in that
instance share the SID, including form loads, challenge assets and submission.
Target names are sent to SOCKS5 without local DNS lookups. No credentials are
included in errors or log messages.
"""

import ipaddress
import re
import secrets
import select
import socket
import threading
import time
from urllib.parse import unquote, urlsplit

MAX_CONNECTIONS = 32
MAX_HEADER = 8192
CONNECT_TIMEOUT = 10
HEADER_TIMEOUT = 5
IDLE_TIMEOUT = 60
SID_PATTERN = re.compile(r"-sid-([A-Za-z0-9]+)(?=-t-)")
CONTROL = re.compile(r"[\x00-\x20\x7f]")
DOMAIN_LABEL = re.compile(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?")


class ProxyError(ValueError):
    """A fixed public error code; never wrap transport exceptions with str()."""


def _domain(value):
    if not isinstance(value, str) or not value or CONTROL.search(value):
        raise ProxyError("invalid_proxy_host")
    try:
        encoded = value.encode("idna").decode("ascii").lower()
    except (UnicodeError, ValueError):
        raise ProxyError("invalid_proxy_host") from None
    if (len(encoded) > 253 or not all(DOMAIN_LABEL.fullmatch(label)
                                    for label in encoded.rstrip(".").split("."))):
        raise ProxyError("invalid_proxy_host")
    return encoded.rstrip(".")


def _configuration(upstream_url):
    try:
        if (not isinstance(upstream_url, str) or len(upstream_url) > 2048 or
                CONTROL.search(upstream_url) or re.search(r"%(?![0-9a-fA-F]{2})", upstream_url)):
            raise ValueError()
        parsed = urlsplit(upstream_url)
        if (parsed.scheme != "socks5" or not parsed.hostname or not parsed.port or
                parsed.path not in ("", "/") or parsed.query or parsed.fragment or
                parsed.username is None or parsed.password is None):
            raise ValueError()
        user = unquote(parsed.username, encoding="utf-8", errors="strict")
        password = unquote(parsed.password, encoding="utf-8", errors="strict")
        if (CONTROL.search(user) or CONTROL.search(password) or
                not 1 <= len(user.encode("utf-8")) <= 255 or
                not 1 <= len(password.encode("utf-8")) <= 255 or
                len(SID_PATTERN.findall(user)) != 1):
            raise ValueError()
        sid = secrets.token_hex(8)
        user = SID_PATTERN.sub("-sid-" + sid, user)
        if len(user.encode("utf-8")) > 255:
            raise ValueError()
        try:
            host = str(ipaddress.ip_address(parsed.hostname))
        except ValueError:
            host = _domain(parsed.hostname)
        return host, parsed.port, user.encode("utf-8"), password.encode("utf-8"), sid
    except (ValueError, UnicodeError, TypeError):
        raise ProxyError("invalid_upstream_proxy") from None


def _target(authority):
    # Only HTTPS is needed. In particular, never proxy local services or SMTP.
    try:
        if authority.startswith("["):
            match = re.fullmatch(r"\[([^\]]+)\]:443", authority)
            if not match:
                raise ValueError()
            host = str(ipaddress.ip_address(match.group(1)))
        else:
            host, port = authority.rsplit(":", 1)
            if port != "443":
                raise ValueError()
            try:
                host = str(ipaddress.ip_address(host))
            except ValueError:
                host = _domain(host)
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None:
            if not address.is_global:
                raise ValueError()
        elif ("." not in host or host.endswith((".localhost", ".local", ".internal", ".test")) or
              host in ("localhost", "localhost.localdomain") or
              re.fullmatch(r"[0-9.]+", host) or
              re.fullmatch(r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*", host)):
            # Reject alternate numeric IP spellings as well as literal IPs.
            raise ValueError()
        return host
    except (ValueError, UnicodeError):
        raise ProxyError("invalid_destination") from None


def _receive_exact(sock, length, deadline):
    output = bytearray()
    while len(output) < length:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProxyError("upstream_timeout")
        sock.settimeout(remaining)
        chunk = sock.recv(length - len(output))
        if not chunk:
            raise ProxyError("upstream_failed")
        output.extend(chunk)
    return bytes(output)


class SessionProxy:
    """A cancellable proxy with an isolated, stable, random upstream SID."""

    def __init__(self, upstream_url):
        self._host, self._port, self._user, self._password, self.sid = _configuration(upstream_url)
        self._stopping = threading.Event()
        self._lock = threading.Lock()
        self._sockets = set()
        self._threads = set()
        self._slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            listener.bind(("127.0.0.1", 0))
            listener.listen(MAX_CONNECTIONS)
            listener.settimeout(0.25)
        except OSError:
            listener.close()
            raise ProxyError("proxy_start_failed") from None
        self._listener = listener
        self.url = "http://127.0.0.1:" + str(listener.getsockname()[1])
        self._accept_thread = threading.Thread(target=self._accept, name="report-proxy", daemon=True)
        self._accept_thread.start()

    def __repr__(self):
        return "<SessionProxy closed=" + str(self._stopping.is_set()) + ">"

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def _track(self, sock):
        with self._lock:
            if self._stopping.is_set():
                sock.close()
                raise ProxyError("proxy_closed")
            self._sockets.add(sock)

    def _dispose(self, sock):
        if sock is None:
            return
        with self._lock:
            self._sockets.discard(sock)
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        sock.close()

    @staticmethod
    def _reject(client, status, reason):
        try:
            client.settimeout(0.5)
            client.sendall(("HTTP/1.1 " + str(status) + " " + reason +
                            "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").encode("ascii"))
        except OSError:
            pass

    def _accept(self):
        while not self._stopping.is_set():
            try:
                client, _peer = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if not self._slots.acquire(blocking=False):
                self._reject(client, 503, "Proxy Busy")
                client.close()
                continue
            try:
                self._track(client)
                thread = threading.Thread(target=self._handle, args=(client,), daemon=True)
                with self._lock:
                    self._threads.add(thread)
                thread.start()
            except (ProxyError, RuntimeError):
                self._dispose(client)
                self._slots.release()

    @staticmethod
    def _read_target(client):
        deadline = time.monotonic() + HEADER_TIMEOUT
        data = bytearray()
        while b"\r\n\r\n" not in data:
            if len(data) >= MAX_HEADER:
                raise ProxyError("invalid_request")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProxyError("invalid_request")
            client.settimeout(remaining)
            chunk = client.recv(min(4096, MAX_HEADER - len(data)))
            if not chunk:
                raise ProxyError("invalid_request")
            data.extend(chunk)
        head, trailing = bytes(data).split(b"\r\n\r\n", 1)
        try:
            lines = head.decode("ascii").split("\r\n")
            method, authority, version = lines[0].split(" ")
            if method != "CONNECT" or version not in ("HTTP/1.0", "HTTP/1.1"):
                raise ValueError()
            for line in lines[1:]:
                if any(ord(char) < 32 or ord(char) == 127 for char in line) or ":" not in line:
                    raise ValueError()
                name, value = line.split(":", 1)
                if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9a-zA-Z-]+", name):
                    raise ValueError()
                if name.lower() == "transfer-encoding" or (
                        name.lower() == "content-length" and value.strip() != "0"):
                    raise ValueError()
            return _target(authority), trailing
        except (ValueError, UnicodeError):
            raise ProxyError("invalid_request") from None

    def _upstream(self, target):
        deadline = time.monotonic() + CONNECT_TIMEOUT
        upstream = None
        try:
            upstream = socket.create_connection((self._host, self._port), timeout=CONNECT_TIMEOUT)
            self._track(upstream)
            upstream.sendall(b"\x05\x01\x02")  # Require username/password authentication.
            if _receive_exact(upstream, 2, deadline) != b"\x05\x02":
                raise ProxyError("upstream_auth_failed")
            upstream.sendall(b"\x01" + bytes([len(self._user)]) + self._user +
                             bytes([len(self._password)]) + self._password)
            if _receive_exact(upstream, 2, deadline) != b"\x01\x00":
                raise ProxyError("upstream_auth_failed")
            # SOCKS remote DNS: do not resolve target locally, even for IP text.
            encoded = target.encode("ascii")
            upstream.sendall(b"\x05\x01\x00\x03" + bytes([len(encoded)]) + encoded + b"\x01\xbb")
            version, reply, reserved, address_type = _receive_exact(upstream, 4, deadline)
            if (version, reply, reserved) != (5, 0, 0):
                raise ProxyError("upstream_connect_failed")
            if address_type == 1:
                address_size = 4
            elif address_type == 4:
                address_size = 16
            elif address_type == 3:
                address_size = _receive_exact(upstream, 1, deadline)[0]
                if address_size == 0:
                    raise ProxyError("upstream_failed")
            else:
                raise ProxyError("upstream_failed")
            _receive_exact(upstream, address_size + 2, deadline)
            upstream.settimeout(IDLE_TIMEOUT)
            return upstream
        except (OSError, ProxyError):
            self._dispose(upstream)
            raise ProxyError("upstream_failed") from None

    def _handle(self, client):
        upstream = None
        connected = False
        try:
            try:
                target, trailing = self._read_target(client)
            except (OSError, ProxyError):
                self._reject(client, 400, "Invalid CONNECT Request")
                return
            upstream = self._upstream(target)
            client.settimeout(IDLE_TIMEOUT)
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            connected = True
            if trailing:
                upstream.sendall(trailing)
            sockets = [client, upstream]
            last_activity = time.monotonic()
            while sockets and not self._stopping.is_set():
                remaining = IDLE_TIMEOUT - (time.monotonic() - last_activity)
                if remaining <= 0:
                    break
                readable, _, _ = select.select(sockets, [], [], min(1, remaining))
                for source in readable:
                    destination = upstream if source is client else client
                    data = source.recv(65536)
                    if not data:
                        sockets.remove(source)
                        try:
                            destination.shutdown(socket.SHUT_WR)
                        except OSError:
                            pass
                        continue
                    destination.sendall(data)
                    last_activity = time.monotonic()
        except (OSError, ValueError):
            if not connected:
                self._reject(client, 502, "Upstream Proxy Failed")
        finally:
            self._dispose(upstream)
            self._dispose(client)
            with self._lock:
                self._threads.discard(threading.current_thread())
            self._slots.release()

    def close(self):
        self._stopping.set()
        self._listener.close()
        with self._lock:
            sockets = list(self._sockets)
        for sock in sockets:
            self._dispose(sock)
        if self._accept_thread is not threading.current_thread():
            self._accept_thread.join(timeout=1)
        with self._lock:
            threads = list(self._threads)
        deadline = time.monotonic() + 1
        for thread in threads:
            if thread is not threading.current_thread() and thread.ident is not None:
                thread.join(timeout=max(0, deadline - time.monotonic()))
