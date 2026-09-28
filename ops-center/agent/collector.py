#!/usr/bin/env python3
"""Linux operations agent: bounded local reads and an explicit service restart allowlist."""
from __future__ import annotations

import argparse
import errno
import hashlib
from contextlib import contextmanager
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import http.cookiejar
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit, urljoin
from urllib.request import build_opener, HTTPCookieProcessor, HTTPRedirectHandler, ProxyHandler, Request

MAX_BODY = 128 * 1024
NETWORK_TIMEOUT = 10
SYSTEMCTL = "/usr/bin/systemctl"
SAFE_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "SYSTEMD_PAGER": "cat"}
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$")
UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$")
KINDS = {"music", "ai", "quota", "bridge", "broker"}
STATES = {"online", "offline", "stopped", "unknown"}
METRIC_FIELDS = ("cpuPercent", "memoryPercent", "diskPercent", "load1", "uptimeSeconds")
RESULT_MESSAGES = {"succeeded": "服务已重启。", "failed": "重启未执行或服务未能启动。", "unknown": "执行结果未确认，请检查服务状态。"}
REPAIR_REASONS = {"gateway_offline", "health_probe_failed"}


class AgentError(Exception):
    pass


def iso(value=None):
    return datetime.fromtimestamp(time.time() if value is None else value, timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.tzinfo else None
    except (ValueError, OverflowError):
        return None


def plain(value, maximum=160, secrets=()):
    result = str(value or "")
    for secret in secrets:
        if secret:
            result = result.replace(secret, "[隐藏]")
    result = re.sub(r"https?://\S+", "[链接]", result, flags=re.I)
    result = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{12,}|admin-[a-f0-9]{16,}|\d+/[A-Za-z0-9+/=]+/[A-Za-z0-9+/=]+)", "[隐藏]", result, flags=re.I)
    result = re.sub(r"(?:authorization|cookie|token|password|secret)\s*[:=]\s*\S+", "[隐藏]", result, flags=re.I)
    return re.sub(r"[\x00-\x1f\x7f]", " ", result)[:maximum]


def checked_url(value, server=False):
    if not isinstance(value, str) or len(value) > 2000 or re.search(r"[\x00-\x20\x7f]", value):
        raise AgentError("INVALID_CONFIG")
    try:
        parsed = urlsplit(value)
        parsed.port
        local = parsed.hostname == "localhost"
        try:
            local = local or ipaddress.ip_address(parsed.hostname or "").is_loopback
        except ValueError:
            pass
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise AgentError("INVALID_CONFIG")
        if parsed.scheme == "http" and not local:
            raise AgentError("INVALID_CONFIG")
        if server:
            return value.rstrip("/") + "/"
        return value.rstrip("/")
    except ValueError:
        raise AgentError("INVALID_CONFIG") from None


def local_probe(value):
    """Only a loopback probe can identify failure of this host's own service."""
    try:
        hostname = urlsplit(value).hostname
        return hostname == "localhost" or ipaddress.ip_address(hostname or "").is_loopback
    except (ValueError, TypeError):
        return False


def transport_failure(error):
    # HTTP failures, invalid JSON, authentication and business errors do not
    # justify restarting the local process. Neither does an unreachable host.
    if isinstance(error, AgentError):
        return str(error) == "HTTP_TIMEOUT"
    if isinstance(error, HTTPError):
        return False
    if isinstance(error, URLError):
        error = error.reason
    return isinstance(error, TimeoutError) or isinstance(error, OSError) and error.errno in {
        errno.ECONNREFUSED, errno.ECONNRESET, errno.ECONNABORTED, errno.ETIMEDOUT, errno.EPIPE}


def repair_fields(probe, reason=None):
    # The service mapping comes from validated local configuration, never from
    # an HTTP health response. The center must independently verify this mapping.
    if "serviceId" not in probe:
        return {}
    return {"serviceId": probe["serviceId"], "repairReason": reason if reason in REPAIR_REASONS else None}


def validate_config(value):
    if not isinstance(value, dict) or not isinstance(value.get("hostId"), str) or not IDENTIFIER.fullmatch(value["hostId"]):
        raise AgentError("INVALID_CONFIG")
    token = value.get("token")
    if not isinstance(token, str) or not 24 <= len(token) <= 512 or re.search(r"[^\x21-\x7e]", token):
        raise AgentError("INVALID_CONFIG")
    interval = value.get("intervalSeconds", 30)
    if isinstance(interval, bool) or not isinstance(interval, int) or not 10 <= interval <= 120:
        raise AgentError("INVALID_CONFIG")
    data_dir = value.get("dataDir", "/var/lib/kook-ops-agent")
    if not isinstance(data_dir, str) or not os.path.isabs(data_dir) or "\0" in data_dir:
        raise AgentError("INVALID_CONFIG")
    services, probes = value.get("services", []), value.get("probes", [])
    collect_metrics = value.get("collectMetrics", True)
    if not isinstance(collect_metrics, bool) or not isinstance(services, list) or len(services) > 30 or not isinstance(probes, list) or len(probes) > 16 \
            or not collect_metrics and services:
        raise AgentError("INVALID_CONFIG")
    service_ids, running_service_ids, units, probe_ids = set(), set(), set(), set()
    normalized_services, normalized_probes = [], []
    for item in services:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not IDENTIFIER.fullmatch(item["id"]) or item["id"] in service_ids \
                or not isinstance(item.get("name"), str) or not 1 <= len(item["name"]) <= 80 \
                or not isinstance(item.get("unit"), str) or not UNIT.fullmatch(item["unit"]) or item["unit"] in units \
                or item.get("expected") not in ("running", "stopped") or not isinstance(item.get("restartAllowed"), bool):
            raise AgentError("INVALID_CONFIG")
        service_ids.add(item["id"]); units.add(item["unit"])
        if item["expected"] == "running":
            running_service_ids.add(item["id"])
        normalized_services.append({key: item[key] for key in ("id", "name", "unit", "expected", "restartAllowed")})
    for item in probes:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not IDENTIFIER.fullmatch(item["id"]) or item["id"] in probe_ids or item.get("kind") not in KINDS:
            raise AgentError("INVALID_CONFIG")
        probe_ids.add(item["id"])
        if "name" in item and (not isinstance(item["name"], str) or not 1 <= len(item["name"]) <= 80):
            raise AgentError("INVALID_CONFIG")
        if "serviceId" in item and (not isinstance(item["serviceId"], str) or item["serviceId"] not in running_service_ids):
            raise AgentError("INVALID_CONFIG")
        normalized_probes.append({"id": item["id"], "kind": item["kind"], "url": checked_url(item.get("url")),
                                  **({"name": item["name"]} if "name" in item else {}),
                                  **({"serviceId": item["serviceId"]} if "serviceId" in item else {})})
    return {"serverUrl": checked_url(value.get("serverUrl"), True), "hostId": value["hostId"], "token": token,
            "intervalSeconds": interval, "dataDir": data_dir, "collectMetrics": collect_metrics, "services": normalized_services, "probes": normalized_probes}


@contextmanager
def absolute_deadline(seconds):
    """Socket inactivity timeouts alone do not bound a slowly trickling response."""
    supported = hasattr(signal, "setitimer") and threading.current_thread() is threading.main_thread()
    previous = None
    if supported:
        previous = signal.getsignal(signal.SIGALRM)
        def expired(*_):
            # Unlike OSError/TimeoutError, this cannot be swallowed by a socket
            # implementation which then tries another resolved IP address.
            raise AgentError("HTTP_TIMEOUT")
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        if supported:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class JsonHttp:
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        # Host-local probes must not inherit an outbound proxy from a login shell.
        self.opener = build_opener(ProxyHandler({}), NoRedirect(), HTTPCookieProcessor(self.cookies))

    def request(self, url, *, body=None, token=None, allow_health_error=False):
        headers = {"Accept": "application/json", "User-Agent": "KOOK-Ops-Agent/1.0"}
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            if len(data) > MAX_BODY:
                raise AgentError("REPORT_TOO_LARGE")
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = "Bearer " + token
        req = Request(url, data=data, method="POST" if body is not None else "GET", headers=headers)
        with absolute_deadline(NETWORK_TIMEOUT):
            try:
                response = self.opener.open(req, timeout=NETWORK_TIMEOUT)
            except HTTPError as error:
                if not allow_health_error or error.code != 503:
                    error.close(); raise AgentError("HTTP_FAILED") from None
                response = error
            with response:
                if int(response.headers.get("Content-Length", "0")) > MAX_BODY:
                    raise AgentError("RESPONSE_TOO_LARGE")
                raw = response.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    raise AgentError("RESPONSE_TOO_LARGE")
                result = json.loads(raw.decode("utf-8"))
                if not isinstance(result, dict):
                    raise AgentError("INVALID_RESPONSE")
                return result


class MetricsCollector:
    def __init__(self, proc_root=Path("/proc"), disk_path="/", statvfs=os.statvfs if hasattr(os, "statvfs") else None):
        self.proc_root, self.disk_path, self.statvfs = Path(proc_root), disk_path, statvfs
        self.previous_cpu = None

    def collect(self):
        result = {key: None for key in METRIC_FIELDS}
        try:
            row = self.proc_root.joinpath("stat").read_text().splitlines()[0].split()
            values = [int(part) for part in row[1:9]]
            if row[0] != "cpu" or len(values) < 4 or min(values) < 0:
                raise ValueError()
            total, idle = sum(values), values[3] + (values[4] if len(values) > 4 else 0)
            if self.previous_cpu:
                delta, idle_delta = total - self.previous_cpu[0], idle - self.previous_cpu[1]
                if delta > 0 and 0 <= idle_delta <= delta:
                    result["cpuPercent"] = round((delta - idle_delta) * 100 / delta, 2)
            self.previous_cpu = (total, idle)
        except (OSError, ValueError, IndexError):
            self.previous_cpu = None
        try:
            entries = dict(line.split(":", 1) for line in self.proc_root.joinpath("meminfo").read_text().splitlines() if ":" in line)
            total, available = (int(entries[name].split()[0]) for name in ("MemTotal", "MemAvailable"))
            if total > 0 and 0 <= available <= total:
                result["memoryPercent"] = round((total - available) * 100 / total, 2)
        except (OSError, ValueError, KeyError, IndexError):
            pass
        try:
            disk = self.statvfs(self.disk_path)
            used = disk.f_blocks - disk.f_bfree
            if used >= 0 and disk.f_bavail >= 0 and used + disk.f_bavail > 0:
                result["diskPercent"] = round(used * 100 / (used + disk.f_bavail), 2)
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        for filename, key in (("loadavg", "load1"), ("uptime", "uptimeSeconds")):
            try:
                value = float(self.proc_root.joinpath(filename).read_text().split()[0])
                if math.isfinite(value) and value >= 0:
                    result[key] = round(value, 2)
            except (OSError, ValueError, IndexError):
                pass
        return result


class ServiceRunner:
    def __init__(self, run=subprocess.run):
        self.run = run

    def status(self, service):
        result = {"id": service["id"], "activeState": "unknown", "subState": "unknown", "pid": None, "restarts": None, "ok": False}
        try:
            proc = self.run([SYSTEMCTL, "show", service["unit"], "--no-pager", "--property=ActiveState,SubState,MainPID,NRestarts"],
                            capture_output=True, text=True, timeout=10, check=False, env=SAFE_ENV, shell=False)
            if proc.returncode or len(proc.stdout) > 32768:
                return result
            values = dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)
            for field, source in (("activeState", "ActiveState"), ("subState", "SubState")):
                if re.fullmatch(r"[a-z-]{1,40}", values.get(source, "")):
                    result[field] = values[source]
            for field, source in (("pid", "MainPID"), ("restarts", "NRestarts")):
                if re.fullmatch(r"\d{1,12}", values.get(source, "")):
                    result[field] = int(values[source])
            result["ok"] = result["activeState"] == ("active" if service["expected"] == "running" else "inactive") \
                and result["subState"] == ("running" if service["expected"] == "running" else "dead") \
                and (service["expected"] != "running" or isinstance(result["pid"], int) and result["pid"] > 0)
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        return result

    def restart(self, service):
        try:
            result = self.run([SYSTEMCTL, "restart", service["unit"]], capture_output=True, text=True,
                              timeout=10, check=False, env=SAFE_ENV, shell=False)
            if result.returncode != 0:
                return "failed"
            return "succeeded" if self.status(service)["ok"] else "failed"
        except subprocess.TimeoutExpired:
            return "unknown"
        except (OSError, subprocess.SubprocessError):
            return "failed"


def atomic_json(file, value):
    file = Path(file); file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=file.name + ".", suffix=".tmp", dir=file.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            os.chmod(temporary, 0o600)
            json.dump(value, output, ensure_ascii=False, allow_nan=False)
            output.flush(); os.fsync(output.fileno())
        os.replace(temporary, file)
        if os.name != "nt":
            fd = os.open(file.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


class CommandLedger:
    def __init__(self, data_dir, write=atomic_json, now=time.time):
        self.file = Path(data_dir) / "commands.json"
        self.write, self.now, self.records, self.failed = write, now, {}, False

    def init(self):
        try:
            if self.file.stat().st_size > 4 * 1024 * 1024:
                raise ValueError()
            value = json.loads(self.file.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("records"), dict) or len(value["records"]) > 5000:
                raise ValueError()
            for identifier, record in value["records"].items():
                if not IDENTIFIER.fullmatch(identifier) or not isinstance(record, dict) or set(record) != {"serviceId", "expiresAt", "createdAt", "acknowledged", "status"} or record.get("status") not in ("executing", "succeeded", "failed", "unknown") \
                        or not isinstance(record.get("acknowledged"), bool) or not IDENTIFIER.fullmatch(str(record.get("serviceId", ""))) \
                        or timestamp(record.get("expiresAt")) is None or isinstance(record.get("createdAt"), bool) \
                        or not isinstance(record.get("createdAt"), (int, float)) or not math.isfinite(record["createdAt"]) or record["createdAt"] < 0 \
                        or record["status"] == "executing" and record["acknowledged"]:
                    raise ValueError()
            self.records = value["records"]
        except FileNotFoundError:
            self.save({})
            return self
        except Exception:
            self.failed = True; raise AgentError("COMMAND_STORAGE") from None
        recovered = {identifier: {**record, "status": "unknown", "acknowledged": False} if record["status"] == "executing" else record for identifier, record in self.records.items()}
        if recovered != self.records:
            self.save(recovered)
        return self

    def save(self, records):
        if self.failed:
            raise AgentError("COMMAND_STORAGE")
        try:
            self.write(self.file, {"version": 1, "records": records})
        except Exception:
            self.failed = True; raise AgentError("COMMAND_STORAGE") from None
        self.records = records

    def pending(self):
        return [{"id": identifier, "status": "unknown" if record["status"] == "executing" else record["status"],
                 "message": RESULT_MESSAGES.get(record["status"], RESULT_MESSAGES["unknown"])}
                for identifier, record in self.records.items() if not record["acknowledged"]][:30]

    def acknowledge(self, identifiers):
        if not identifiers or self.failed:
            return
        records = {identifier: {**record, "acknowledged": True} if identifier in identifiers else record for identifier, record in self.records.items()}
        self.save(records)

    def execute(self, command, services, runner):
        if self.failed or not isinstance(command, dict) or not isinstance(command.get("id"), str) or not IDENTIFIER.fullmatch(command["id"]):
            return
        identifier = command["id"]
        if identifier in self.records:
            return
        service_id, expires = command.get("serviceId"), timestamp(command.get("expiresAt"))
        if not isinstance(service_id, str) or not IDENTIFIER.fullmatch(service_id) or expires is None:
            return
        # Expired deduplication entries remain for seven days; pending results are
        # never evicted. A replay of its original command is already expired.
        records = {key: value for key, value in self.records.items() if not value["acknowledged"] or self.now() - timestamp(value["expiresAt"]) < 7 * 86400}
        if len(records) >= 5000:
            raise AgentError("COMMAND_CAPACITY")
        service = services.get(service_id)
        allowed = set(command) == {"id", "serviceId", "action", "expiresAt"} and command.get("action") == "restart" and service is not None and service["restartAllowed"] \
            and service["expected"] == "running" and self.now() < expires <= self.now() + 600
        record = {"serviceId": service_id, "expiresAt": command["expiresAt"], "createdAt": self.now(), "acknowledged": False, "status": "executing" if allowed else "failed"}
        records[identifier] = record; self.save(records)
        if not allowed:
            return
        # Slow disk persistence is not authorization to act after the lease ends.
        if self.now() >= expires:
            self.save({**self.records, identifier: {**record, "status": "failed"}})
            return
        try:
            status = runner.restart(service)
        except Exception:
            status = "unknown"
        if status not in RESULT_MESSAGES:
            status = "unknown"
        updated = {**self.records, identifier: {**record, "status": status}}
        try:
            self.save(updated)
        except AgentError:
            # Durable state still says executing: never run it again. Return an
            # in-memory unknown result and keep all further commands disabled.
            self.records = {**self.records, identifier: {**record, "status": "unknown"}}
            raise


class ProbeCollector:
    def __init__(self, http=None, now=time.time, secrets=()):
        self.http, self.now, self.secrets = http or JsonHttp(), now, secrets
        self.music_sessions = set()

    def bot(self, probe, identifier=None, name=None, state="unknown", channel=None, playing=None, error="", health=None, transport=None, repair_reason=None, uptime_seconds=None, started_at=None):
        identity = str(identifier or probe["id"])
        if not IDENTIFIER.fullmatch(identity) or plain(identity, 1000, self.secrets) != identity:
            identity = probe["id"][:60] + ":" + hashlib.sha256(identity.encode("utf-8", errors="replace")).hexdigest()[:32]
        return {"id": identity, "name": plain(name or probe.get("name") or probe["id"], 80, self.secrets), "kind": probe["kind"],
                "state": state if state in STATES else "unknown", "channelName": plain(channel, 100, self.secrets),
                "playing": playing if isinstance(playing, bool) else None, "lastError": plain(error, 200, self.secrets),
                "health": health if health in ("healthy", "degraded", "unknown") else "healthy" if state in ("online", "stopped") else "degraded" if state == "offline" else "unknown",
                "transport": transport if transport in ("connected", "disconnected") else None,
                **repair_fields(probe, repair_reason),
                **({"uptimeSeconds": uptime_seconds, "startedAt": started_at} if probe["kind"] == "music" else {})}

    def connection(self, value):
        if value.get("running") is False or value.get("enabled") is False:
            return "stopped"
        if value.get("connected") is True:
            last_pong = timestamp(value.get("lastPongAt"))
            if last_pong is not None and not -60 <= self.now() - last_pong <= 120:
                return "unknown"
            return "online"
        if value.get("connected") is False:
            return "offline"
        return "unknown"

    def collect(self, probe):
        try:
            if probe["kind"] == "music":
                return self.music(probe)
            value = self.http.request(probe["url"], allow_health_error=True)
            if probe["kind"] == "ai":
                gateways = value.get("bots") if isinstance(value.get("bots"), list) else [value.get("gateway")]
                return [self.bot(probe, f"{probe['id']}:{item.get('botId') or index}", item.get("label") or probe.get("name") or probe["id"],
                                 "unknown" if value.get("ok") is False and self.connection(item) == "online" else self.connection(item),
                                 value.get("channelId"), error=item.get("lastError") or value.get("chat", {}).get("lastError") or "",
                                 repair_reason="gateway_offline" if self.connection(item) == "offline"
                                 and value.get("running") is not False and value.get("enabled") is not False
                                 and value.get("chat", {}).get("enabled") is not False else None)
                        for index, item in enumerate(gateways[:32]) if isinstance(item, dict)] or [self.bot(probe)]
            if probe["kind"] == "quota":
                query = value.get("keyQueryBot")
                if isinstance(query, dict):
                    return [self.bot(probe, name=probe.get("name") or "额度查询机器人", state=self.connection(query), error=query.get("lastError") or query.get("queryLastError") or "",
                                     repair_reason="gateway_offline" if self.connection(query) == "offline" and value.get("enabled") is not False and value.get("running") is not False else None)]
            if probe["kind"] == "bridge":
                queue = value.get("queue", {})
                state = "online" if value.get("status") == "ok" and not queue.get("lastError") else "unknown"
                return [self.bot(probe, name=probe.get("name") or "GitHub 通知机器人", state=state, error=queue.get("lastError") or "")]
            state = "online" if value.get("status") == "ok" or value.get("ok") is True else "unknown"
            return [self.bot(probe, state=state)]
        except (OSError, ValueError, TypeError, AttributeError, AgentError) as error:
            return [self.bot(probe, error="状态暂不可用",
                             repair_reason="health_probe_failed" if local_probe(probe.get("url")) and transport_failure(error) else None)]

    def music(self, probe):
        base = probe["url"].rstrip("/")
        if urlsplit(base).path not in ("", "/"):
            raise AgentError("INVALID_MUSIC_PROBE")
        if base not in self.music_sessions:
            session = self.http.request(base + "/api/session")
            if session.get("authenticated") is not True:
                raise AgentError("GUEST_SESSION_UNAVAILABLE")
            self.music_sessions.add(base)
        try:
            descriptors = self.http.request(base + "/api/bots")
            health = self.http.request(base + "/api/health")
        except (OSError, ValueError, AgentError):
            self.music_sessions.discard(base)
            raise
        generated = health.get("generatedAt")
        fresh = isinstance(generated, (int, float)) and not isinstance(generated, bool) and -60 <= self.now() - generated / 1000 <= 120
        bots = descriptors.get("bots"), health.get("bots")
        if not all(isinstance(items, list) for items in bots):
            raise AgentError("INVALID_MUSIC_RESPONSE")
        by_id = {str(item.get("id")): item for item in bots[1] if isinstance(item, dict)}
        result = []
        for item in bots[0][:64]:
            if not isinstance(item, dict):
                continue
            record = by_id.get(str(item.get("id")), {})
            state = "stopped" if item.get("status") in ("stopped", "removed", "stopping") else \
                "online" if item.get("online") is True else "offline" if item.get("online") is False else "unknown"
            if not fresh:
                state = "unknown"
            context = item.get("context") if isinstance(item.get("context"), dict) else {}
            channel = record.get("channelName") or record.get("channelId") or context.get("voiceChannelId")
            issue = record.get("issue") or item.get("error") or ""
            playing = record.get("status") == "playing"
            transport = record.get("transport") if record.get("transport") in ("connected", "disconnected") else None
            business = "unknown" if not fresh or not record else "degraded" if issue or record.get("level") in ("error", "warning") \
                or playing and transport == "disconnected" else "healthy"
            if playing and transport == "disconnected" and not issue:
                issue = "语音发送连接已中断，播放状态需核对。"
            if business == "unknown" and not issue:
                issue = "状态样本已过期" if not fresh else "缺少机器人健康记录"
            if state == "stopped" and fresh:
                business, issue, playing, transport = "healthy", "", False, None
            uptime = item.get("uptimeSeconds")
            started = timestamp(item.get("startedAt"))
            runtime_known = state in ("online", "offline") and fresh and business != "unknown"
            uptime = math.floor(uptime) if runtime_known and isinstance(uptime, (int, float)) and not isinstance(uptime, bool) and math.isfinite(uptime) and 0 <= uptime <= 1e12 else None
            started_at = iso(started) if runtime_known and started is not None and 0 <= started <= self.now() + 60 else None
            result.append(self.bot(probe, f"{probe['id']}:{item.get('id', len(result))}", item.get("name") or item.get("username"), state,
                                   channel, playing if business == "healthy" else False if business == "degraded" else None,
                                   issue, business, transport if fresh else None,
                                   repair_reason="gateway_offline" if fresh and state == "offline"
                                   and item.get("enabled") is not False and item.get("running") is not False else None,
                                   uptime_seconds=uptime, started_at=started_at))
        return result


class Agent:
    def __init__(self, config, http=None, metrics=None, services=None, probes=None, ledger=None, now=time.time):
        self.config, self.now = validate_config(config), now
        self.http = http or JsonHttp()
        self.metrics = metrics or MetricsCollector()
        self.services = services or ServiceRunner()
        self.probes = probes or ProbeCollector(now=now, secrets=(self.config["token"],))
        self.ledger = ledger or CommandLedger(self.config["dataDir"], now=now)
        self.ledger.init()
        self.service_map = {service["id"]: service for service in self.config["services"]}
        self.stopping = threading.Event()

    def collect(self):
        collected = time.monotonic()
        metrics = self.metrics.collect() if self.config["collectMetrics"] else {key: None for key in METRIC_FIELDS}
        # Fixed systemctl reads run concurrently so a few unresponsive services
        # cannot age every later bot sample past two minutes before reporting.
        services = []
        if self.config["collectMetrics"]:
            with ThreadPoolExecutor(max_workers=8) as executor:
                services = list(executor.map(self.services.status, self.config["services"]))
        bots = []
        for probe in self.config["probes"]:
            if self.stopping.is_set() or time.monotonic() - collected >= 60:
                bots.append((time.monotonic(), {"id": probe["id"], "name": plain(probe.get("name") or probe["id"], 80), "kind": probe["kind"],
                                               "state": "unknown", "channelName": "", "playing": None, "lastError": "本轮采集已达到等待上限",
                                               **repair_fields(probe)}))
                continue
            observed = time.monotonic()
            bots.extend((observed, bot) for bot in self.probes.collect(probe))
        finished = time.monotonic()
        if len(bots) > 40:
            bots = bots[:39] + [(finished, {"id": "probe-capacity", "name": "采集容量提示", "kind": "broker", "state": "unknown", "channelName": "",
                                          "playing": None, "lastError": "机器人数量超过本次报告容量，请拆分采集配置。"})]
        if finished - collected > 120:
            metrics = {key: None for key in metrics}
            services = [{**service, "activeState": "unknown", "subState": "unknown", "ok": False} for service in services]
        return {"hostId": self.config["hostId"], "observedAt": iso(self.now()), "metrics": metrics, "services": services,
                "bots": [{**bot, "state": "unknown", "health": "unknown", "transport": None, "playing": None, "lastError": "状态样本已过期",
                          **({"uptimeSeconds": None, "startedAt": None} if bot.get("kind") == "music" else {}),
                          **({"repairReason": None} if "repairReason" in bot else {})} if finished - at > 120 else bot for at, bot in bots],
                "commandResults": self.ledger.pending()}

    def cycle(self):
        report = self.collect()
        if self.stopping.is_set():
            return report
        response = self.http.request(urljoin(self.config["serverUrl"], "api/agent/report"), body=report, token=self.config["token"])
        commands = response.get("commands", [])
        if not isinstance(commands, list) or len(commands) > 20:
            raise AgentError("INVALID_RESPONSE")
        self.ledger.acknowledge({result["id"] for result in report["commandResults"]})
        executing_since = time.monotonic()
        for command in commands:
            if self.stopping.is_set() or time.monotonic() - executing_since >= 60:
                break
            self.ledger.execute(command, self.service_map if self.config["collectMetrics"] else {}, self.services)
        return report


def main():
    parser = argparse.ArgumentParser(description="Push bounded Linux service and bot health to the operations center.")
    parser.add_argument("--config", default="/etc/kook-ops-agent/config.json")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    try:
        file = Path(args.config)
        if file.stat().st_size > MAX_BODY:
            raise AgentError("INVALID_CONFIG")
        config = validate_config(json.loads(file.read_text(encoding="utf-8")))
        lock = None
        if os.name != "nt":
            import fcntl
            data_dir = Path(config["dataDir"]); data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            lock = os.fdopen(os.open(data_dir / "agent.lock", os.O_CREAT | os.O_RDWR, 0o600), "w")
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        agent = Agent(config)
    except (OSError, ValueError, AgentError):
        print(json.dumps({"event": "agent_start_failed"}), flush=True)
        return 1
    stopping = agent.stopping
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, lambda *_: stopping.set())
    while not stopping.is_set():
        started = time.monotonic()
        try:
            agent.cycle()
        except (OSError, ValueError, TypeError, AgentError):
            print(json.dumps({"event": "agent_cycle_failed"}), flush=True)
            if args.once:
                return 1
        if args.once:
            return 0
        stopping.wait(max(1, agent.config["intervalSeconds"] - (time.monotonic() - started)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
