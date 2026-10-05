import socket
import threading
import unittest
from unittest.mock import patch

from report_proxy import ProxyError, SessionProxy, _configuration


def _read_exact(sock, count):
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise AssertionError("unexpected EOF")
        data += chunk
    return data


class FakeSocks:
    def __init__(self, connections=1, auth_reply=b"\x01\x00", connect_reply=None):
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(2)
        self.port = self.listener.getsockname()[1]
        self.connections = connections
        self.auth_reply = auth_reply
        self.connect_reply = connect_reply
        self.user = None
        self.users = []
        self.destination = None
        self.error = None
        self.connected = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        sock = None
        try:
            self.listener.settimeout(2)
            for _ in range(self.connections):
                sock, _ = self.listener.accept()
                sock.settimeout(2)
                self._run_client(sock)
                sock.close()
                sock = None
        except Exception as exc:
            self.error = exc
        finally:
            if sock:
                sock.close()
            self.listener.close()

    def _run_client(self, sock):
        self.assert_bytes(_read_exact(sock, 3), b"\x05\x01\x02")
        sock.sendall(b"\x05\x02")
        auth = _read_exact(sock, 2)
        self.assert_bytes(auth, b"\x01" + auth[1:])
        user = _read_exact(sock, auth[1])
        plen = _read_exact(sock, 1)[0]
        password = _read_exact(sock, plen)
        self.user = user.decode("ascii")
        self.users.append(self.user)
        self.password = password.decode("ascii")
        sock.sendall(self.auth_reply)
        if self.auth_reply != b"\x01\x00":
            return
        request = _read_exact(sock, 5)
        self.assert_bytes(request[:4], b"\x05\x01\x00\x03")
        size = request[4]
        self.destination = _read_exact(sock, size).decode("ascii")
        self.assert_bytes(_read_exact(sock, 2), b"\x01\xbb")
        sock.sendall(self.connect_reply or b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x01")
        if self.connect_reply:
            return
        self.connected.set()
        while True:
            data = sock.recv(65536)
            if not data:
                return
            sock.sendall(data)

    @staticmethod
    def assert_bytes(actual, expected):
        if actual != expected:
            raise AssertionError("protocol mismatch")

    def close(self):
        try:
            self.listener.close()
        except OSError:
            pass
        self.thread.join(timeout=2)
        if self.error:
            raise self.error


class SessionProxyTests(unittest.TestCase):
    @staticmethod
    def connect(proxy, authority=b"example.com:443", trailing=b""):
        client = socket.create_connection(("127.0.0.1", int(proxy.url.rsplit(":", 1)[1])))
        client.settimeout(2)
        client.sendall(b"CONNECT " + authority + b" HTTP/1.1\r\nHost: example.com\r\n\r\n" + trailing)
        return client

    def test_sid_is_stable_per_session_and_random_between_sessions(self):
        config = "socks5://u-region-US-sid-oldSID-t-5:p@127.0.0.1:1"
        first = _configuration(config)
        second = _configuration(config)
        self.assertNotEqual(first[-1], second[-1])
        self.assertRegex(first[-1], r"^[0-9a-f]{16}$")
        self.assertIn("-sid-" + first[-1] + "-t-", first[2].decode())

    def test_connect_tunnel_uses_remote_dns_and_authenticated_sid(self):
        fake = FakeSocks(connections=2)
        proxy = SessionProxy("socks5://u-region-US-sid-oldSID-t-5:pass@127.0.0.1:" + str(fake.port))
        try:
            for _ in range(2):
                with self.connect(proxy) as client:
                    self.assertTrue(client.recv(128).startswith(b"HTTP/1.1 200"))
                    client.sendall(b"hello")
                    self.assertEqual(client.recv(5), b"hello")
            fake.thread.join(timeout=2)
            self.assertIsNone(fake.error)
            self.assertEqual(fake.destination, "example.com")
            self.assertEqual(fake.user, "u-region-US-sid-" + proxy.sid + "-t-5")
            self.assertEqual(fake.users[0], fake.users[1])
            self.assertEqual(fake.password, "pass")
        finally:
            proxy.close()
            fake.close()

    def test_rejects_non_https_or_private_destination_without_upstream(self):
        proxy = SessionProxy("socks5://user-region-US-sid-old-t-5:secret@127.0.0.1:1")
        try:
            with patch("report_proxy.socket.create_connection", side_effect=AssertionError("upstream reached")):
                for target in (b"127.0.0.1:443", b"10.0.0.1:443", b"169.254.169.254:443",
                               b"[::1]:443", b"localhost:443", b"host.local:443", b"example.com:80",
                               b"127.1:443", b"2130706433:443", b"0x7f.0.0.1:443"):
                    with self.subTest(target=target), socket.socket() as client:
                        client.connect(("127.0.0.1", int(proxy.url.rsplit(":", 1)[1])))
                        client.settimeout(2)
                        client.sendall(b"CONNECT " + target + b" HTTP/1.1\r\n\r\n")
                        self.assertTrue(client.recv(256).startswith(b"HTTP/1.1 400"))
        finally:
            proxy.close()

    def test_invalid_proxy_does_not_expose_secret(self):
        for value in ("http://user-region-US-sid-x-t-5:secret@x:1", "socks5://nosecret@x:1",
                      "socks5://u-sid-old-t-5:secret@x:65536", "socks5://u:secret@x:1",
                      "socks5://u-sid-old-t-5:secret@x:1?key=secret",
                      "socks5://u-sid-old-t-5:%0asecret@x:1",
                      "socks5://u-sid-old-t-5:%GGsecret@x:1",
                      "socks5://u-sid-old-t-5:secret@x:1/secret"):
            with self.assertRaises(ProxyError) as context:
                SessionProxy(value)
            self.assertNotIn("secret", str(context.exception))

    def test_auth_failure_is_sanitized(self):
        fake = FakeSocks(auth_reply=b"\x01\x01")
        try:
            with SessionProxy("socks5://u-sid-old-t-5:password@127.0.0.1:" + str(fake.port)) as proxy:
                with self.connect(proxy) as client:
                    response = client.recv(512)
                    self.assertTrue(response.startswith(b"HTTP/1.1 502"))
                    self.assertNotIn(b"password", response)
                    self.assertNotIn(proxy.sid.encode(), response)
                self.assertNotIn("password", repr(proxy))
        finally:
            fake.close()

    def test_bad_socks_reply_does_not_open_tunnel(self):
        fake = FakeSocks(connect_reply=b"\x05\x01\x00\x01")
        try:
            with SessionProxy("socks5://u-sid-old-t-5:password@127.0.0.1:" + str(fake.port)) as proxy:
                with self.connect(proxy) as client:
                    self.assertTrue(client.recv(512).startswith(b"HTTP/1.1 502"))
        finally:
            fake.close()

    def test_close_cancels_existing_tunnel(self):
        fake = FakeSocks()
        proxy = SessionProxy("socks5://u-sid-old-t-5:password@127.0.0.1:" + str(fake.port))
        try:
            with self.connect(proxy) as client:
                self.assertTrue(client.recv(128).startswith(b"HTTP/1.1 200"))
                self.assertTrue(fake.connected.wait(2))
                proxy.close()
                self.assertEqual(client.recv(128), b"")
                self.assertFalse(proxy._sockets)
        finally:
            proxy.close()
            fake.close()

    def test_invalid_method_headers_and_size_are_rejected(self):
        with SessionProxy("socks5://u-sid-old-t-5:secret@127.0.0.1:1") as proxy:
            for request in (b"GET https://example.com/ HTTP/1.1\r\n\r\n",
                            b"CONNECT example.com:443 HTTP/1.1\r\nContent-Length: 1\r\n\r\nx",
                            b"CONNECT example.com:443 HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
                            b"CONNECT example.com:443 HTTP/1.1\r\nBad\tHeader: x\r\n\r\n",
                            b"x" * 8192):
                with self.subTest(request=request[:50]):
                    with socket.create_connection(("127.0.0.1", int(proxy.url.rsplit(":", 1)[1]))) as client:
                        client.settimeout(2)
                        client.sendall(request)
                        self.assertTrue(client.recv(256).startswith(b"HTTP/1.1 400"))

    def test_encoded_password_and_username_preserved_except_sid(self):
        configured = _configuration("socks5://u%2B-region-US-sid-old-t-5:p%40%3A%2F@127.0.0.1:1")
        self.assertTrue(configured[2].startswith(b"u+-region-US-sid-"))
        self.assertEqual(configured[3], b"p@:/")

    def test_close_stops_listener(self):
        proxy = SessionProxy("socks5://user-region-US-sid-old-t-5:secret@127.0.0.1:1")
        address = ("127.0.0.1", int(proxy.url.rsplit(":", 1)[1]))
        proxy.close()
        with self.assertRaises(OSError):
            socket.create_connection(address, timeout=0.2)


if __name__ == "__main__":
    unittest.main()
