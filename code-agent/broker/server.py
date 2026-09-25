"""Local authenticated Unix-socket RPC for trusted repository tools."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import re
import shutil
import socket
import socketserver
import stat
import struct
import tempfile
import threading
import time
import uuid

from .repository import RepositoryBackend, RepositoryError, REPOSITORY
from .sandbox import SandboxRunner
from .workspace import Workspace, WorkspaceError
from .projects import PROJECTS, CHECK_PROTOCOL

MAX_REQUEST = 512 * 1024
MAX_RESPONSE = 256 * 1024
MAX_JOBS = 30
_SHA = re.compile(r"^[a-f0-9]{40}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_FIELDS = {
    "create_job": (set(), set()), "job_status": (set(), set()), "cancel_operation": (set(), set()),
    "workspace_info": (set(), set()), "list_files": ({"path", "limit"}, set()),
    "read_file": ({"path", "startLine", "maxLines"}, {"path"}),
    "search_code": ({"query", "path", "maxResults"}, {"query"}),
    "write_file": ({"path", "content", "expectedSha256"}, {"path", "content", "expectedSha256"}),
    "replace_text": ({"path", "oldText", "newText", "expectedSha256"}, {"path", "oldText", "newText", "expectedSha256"}),
    "get_diff": ({"path", "maxChars"}, set()), "run_checks": ({"project", "testFiles"}, set()),
    "publish": ({"report"}, {"report"}),
}
_REPORT_FIELDS = {"approved", "checksPassed", "reviewPassed", "workHash", "checks", "review", "operatorId", "summary", "steps", "cycles", "repository", "jobId", "baseSha"}


class BrokerError(Exception):
    def __init__(self, code):
        self.code = code if isinstance(code, str) and _CODE.fullmatch(code) else "BROKER_FAILED"
        super().__init__(self.code)


def _canonical_job(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise BrokerError("INVALID_JOB") from None
    return value


def _no_links(path):
    path = Path(os.path.abspath(os.fspath(path)))
    for candidate in (path, *path.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise BrokerError("INVALID_PATH")
    return path


def _private_json(path, value):
    path = _no_links(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".broker-", delete=False) as stream:
            temporary = stream.name
            stream.write(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        temporary = None
    except (OSError, ValueError, UnicodeError):
        raise BrokerError("STORAGE") from None
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def _pairs(values):
    result = {}
    for key, value in values:
        if key in result:
            raise ValueError("duplicate")
        result[key] = value
    return result


def decode_request(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_REQUEST:
        raise BrokerError("REQUEST_LIMIT")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("constant")))
    except (ValueError, UnicodeError, RecursionError):
        raise BrokerError("INVALID_REQUEST") from None
    if not isinstance(value, dict) or set(value) != {"operation", "jobId", "args"}:
        raise BrokerError("INVALID_REQUEST")
    return value


def _publication(value, expected_branch):
    if (not isinstance(value, dict) or value.get("published") is not True
            or value.get("branch") != expected_branch or not _SHA.fullmatch(value.get("commit", ""))):
        raise BrokerError("INVALID_PUBLICATION")
    result = {"published": True, "repository": REPOSITORY, "branch": expected_branch, "commit": value["commit"]}
    base = "https://github.com/" + REPOSITORY
    for key in ("prUrl", "compareUrl", "prLookupUrl"):
        url = value.get(key)
        if isinstance(url, str) and len(url) <= 2048 and url.startswith(base + "/") and not re.search(r"[\x00-\x20]", url):
            result[key] = url
    return result


class Broker:
    def __init__(self, rootdir, *, repository, sandbox, max_jobs=MAX_JOBS):
        if not isinstance(max_jobs, int) or not 1 <= max_jobs <= MAX_JOBS:
            raise BrokerError("CONFIG")
        self.root = _no_links(rootdir)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self.jobs = _no_links(self.root / "jobs")
        self.jobs.mkdir(mode=0o700, exist_ok=True)
        os.chmod(self.jobs, 0o700)
        self.repository, self.sandbox, self.max_jobs = repository, sandbox, max_jobs
        self._registry = threading.RLock()
        self._create_lock = threading.Lock()
        self._job_locks = {}
        self._cancellations = {}
        self._sandbox_slot = threading.Semaphore(1)

    def _job_root(self, job_id):
        job_id = _canonical_job(job_id)
        root = _no_links(self.jobs / job_id)
        if not root.is_dir():
            raise BrokerError("JOB_NOT_FOUND")
        return root

    def _lock(self, job_id):
        with self._registry:
            return self._job_locks.setdefault(job_id, threading.RLock())

    def _load(self, job_root):
        try:
            path = _no_links(job_root / "job.json")
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > 2 * 1024 * 1024:
                raise BrokerError("INVALID_STATE")
            value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_pairs)
            if (not isinstance(value, dict) or value.get("version") != 1 or value.get("jobId") != job_root.name
                    or not isinstance(value.get("meta"), dict) or value["meta"].get("repository") != REPOSITORY
                    or not _SHA.fullmatch(value["meta"].get("baseSha", ""))
                    or value["meta"].get("branch") != "kook-agent/task-" + job_root.name
                    or not isinstance(value.get("checks"), list) or len(value["checks"]) > 20):
                raise BrokerError("INVALID_STATE")
            return value
        except BrokerError:
            raise
        except (OSError, ValueError, UnicodeError, TypeError):
            raise BrokerError("INVALID_STATE") from None

    def _create(self):
        with self._create_lock:
            if sum(1 for _ in self.jobs.iterdir()) >= self.max_jobs:
                raise BrokerError("CAPACITY")
            job_id = str(uuid.uuid4())
            root = self.jobs / job_id
            # mkdir must succeed before this call owns anything to roll back.
            # A UUID collision must never delete a previously created task.
            root.mkdir(mode=0o700)
            identity = root.stat()
            try:
                return self._initialize_job(job_id, root)
            except Exception as original:
                try:
                    self._discard_failed_creation(job_id, root, identity)
                except Exception:
                    code = original.code if isinstance(original, (BrokerError, RepositoryError, WorkspaceError)) else "BROKER_FAILED"
                    error = BrokerError(code)
                    error.cleanup_failed = True
                    raise error from None
                raise

    def _discard_failed_creation(self, job_id, root, identity):
        # The broker owns this newly created UUID directory. Do not scan, prune
        # or infer ownership of other jobs, including completed/published jobs.
        if root != self.jobs / _canonical_job(job_id) or root.parent != self.jobs:
            raise BrokerError("INVALID_PATH")
        _no_links(root)
        current = root.lstat()
        if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
            raise BrokerError("INVALID_PATH")
        if (root / "job.json").exists() or (root / "job.json").is_symlink():
            raise BrokerError("INVALID_STATE")
        discard = getattr(self.repository, "discard_prepared", None)
        if discard is not None:
            discard(job_id, root)
        shutil.rmtree(root)

    def _initialize_job(self, job_id, root):
        os.chmod(root, 0o700)
        meta = self.repository.prepare(job_id, root)
        if (not isinstance(meta, dict) or meta.get("repository") != REPOSITORY
                or not _SHA.fullmatch(meta.get("baseSha", "")) or meta.get("branch") != "kook-agent/task-" + job_id):
            raise BrokerError("INVALID_PREPARED_STATE")
        meta = {key: meta[key] for key in ("repository", "baseSha", "branch")}
        workspace = Workspace(root / "work", root / "baseline")
        workspace.info()
        # Snapshot source is mounted read-only and must be readable by uid 1000.
        for folder, directories, files in os.walk(workspace.root, followlinks=False):
            _no_links(folder)
            os.chmod(folder, 0o755)
            for name in directories:
                _no_links(Path(folder) / name)
            for name in files:
                os.chmod(_no_links(Path(folder) / name), 0o644)
        _private_json(root / "job.json", {"version": 1, "jobId": job_id, "meta": meta,
                      "status": "ready", "checks": [], "publication": None, "createdAt": time.time()})
        return {"jobId": job_id, **meta}

    def dispatch(self, operation, jobId, args):
        if not isinstance(operation, str) or operation not in _FIELDS or not isinstance(args, dict):
            raise BrokerError("INVALID_REQUEST")
        allowed, required = _FIELDS[operation]
        if set(args) - allowed or required - set(args):
            raise BrokerError("INVALID_ARGUMENTS")
        if "path" in args and args["path"] is not None and not isinstance(args["path"], str):
            raise BrokerError("INVALID_ARGUMENTS")
        if operation == "run_checks" and args.get("project") is not None and not isinstance(args["project"], str):
            raise BrokerError("INVALID_ARGUMENTS")
        try:
            if operation == "create_job":
                if jobId is not None:
                    raise BrokerError("INVALID_JOB")
                return self._create()
            root = self._job_root(jobId)
            if operation == "cancel_operation":
                with self._registry:
                    event = self._cancellations.get(jobId)
                    if event is not None:
                        event.set()
                return {"cancelled": event is not None}
            with self._lock(jobId):
                state = self._load(root)
                workspace = Workspace(root / "work", root / "baseline")
                if operation == "job_status":
                    return self._status(root, state)
                if state.get("publication") and operation in ("write_file", "replace_text", "run_checks"):
                    raise BrokerError("JOB_PUBLISHED")
                if operation == "workspace_info":
                    return workspace.info()
                if operation == "list_files":
                    return workspace.list_files(args.get("path") or "", args.get("limit", 200))
                if operation == "read_file":
                    return workspace.read_file(args["path"], args.get("startLine", 1), args.get("maxLines", 200))
                if operation == "search_code":
                    return workspace.search_code(args["query"], args.get("path") or "", args.get("maxResults", 50))
                if operation == "write_file":
                    result = workspace.write_file(args["path"], args["content"], args["expectedSha256"])
                elif operation == "replace_text":
                    result = workspace.replace_text(args["path"], args["oldText"], args["newText"], args["expectedSha256"])
                elif operation == "get_diff":
                    return workspace.get_diff(args.get("path"), args.get("maxChars", 40000))
                elif operation == "run_checks":
                    return self._checks(root, state, workspace, args)
                elif operation == "publish":
                    return self._publish(root, state, workspace, args["report"])
                else:
                    raise BrokerError("INVALID_REQUEST")
                state["status"] = "modified"
                _private_json(root / "job.json", state)
                return result
        except (WorkspaceError, RepositoryError) as error:
            raise BrokerError(error.code) from None
        except BrokerError:
            raise
        except Exception:
            raise BrokerError("BROKER_FAILED") from None

    def _checks(self, root, state, workspace, args):
        event = threading.Event()
        job_id = state["jobId"]
        with self._registry:
            self._cancellations[job_id] = event
        acquired = False
        try:
            while not event.is_set():
                if self._sandbox_slot.acquire(timeout=0.1):
                    acquired = True
                    break
            if event.is_set():
                result = {"passed": False, "complete": False, "workHash": workspace.work_hash(), "exitCode": None,
                          "summary": "测试已取消。", "output": "", "truncated": False, "project": args.get("project") or "all", "errorCode": "CANCELLED"}
            else:
                state["status"] = "checking"
                _private_json(root / "job.json", state)
                result = self.sandbox.run(workspace, project=args.get("project") or "all",
                                          test_files=args.get("testFiles", []), cancel_event=event)
            if not isinstance(result, dict):
                raise BrokerError("INVALID_CHECK_RESULT")
            output = result.get("output", "")
            if not isinstance(output, str):
                output = ""
            output = output.encode("utf-8", errors="replace")[:65536].decode("utf-8", errors="ignore")
            check = {"passed": result.get("passed") is True and not event.is_set(),
                     "complete": result.get("complete") is True and not event.is_set(),
                     "workHash": result.get("workHash"), "exitCode": result.get("exitCode"),
                     "summary": str(result.get("summary", ""))[:1000], "output": output,
                     "truncated": result.get("truncated") is True,
                     "project": result.get("project") if result.get("project") in ("all", *PROJECTS) else "all",
                     "coveredProjects": result.get('coveredProjects', []), "checkProtocol": result.get('checkProtocol'),
                     "checkedAt": time.time(), "checkId": str(uuid.uuid4())}
            if not isinstance(check["workHash"], str) or not _HASH.fullmatch(check["workHash"]):
                check.update(workHash=workspace.work_hash(), passed=False, complete=False)
            if type(check["exitCode"]) is not int or check["exitCode"] != 0:
                check.update(passed=False, complete=False)
            if check["workHash"] != workspace.work_hash():
                check.update(passed=False, complete=False)
            coverage = check['coveredProjects']
            if (check['checkProtocol'] != CHECK_PROTOCOL or not isinstance(coverage, list)
                    or any(not isinstance(name, str) or name not in PROJECTS for name in coverage)
                    or not set(coverage) >= set(workspace.changed_projects() or PROJECTS)):
                check['complete'] = False
            code = "CANCELLED" if event.is_set() else result.get("errorCode")
            if isinstance(code, str) and _CODE.fullmatch(code):
                check["errorCode"] = code
            state["checks"] = (state["checks"] + [check])[-20:]
            state["status"] = "checked" if check["passed"] else "check_failed"
            _private_json(root / "job.json", state)
            visible = dict(check)
            visible["output"] = output
            if len(output) > 16000:
                marker = "\n... [output truncated] ...\n"
                head = (16000 - len(marker)) // 2
                tail = 16000 - len(marker) - head
                visible["output"] = output[:head] + marker + output[-tail:]
            visible["truncated"] = check["truncated"] or len(output) > 16000
            visible["checks"] = [{"name": check["project"] + " fixed checks", **{key: check[key]
                for key in ("passed", "complete", "workHash", "exitCode", "summary")}}]
            return visible
        finally:
            if acquired:
                self._sandbox_slot.release()
            with self._registry:
                if self._cancellations.get(job_id) is event:
                    del self._cancellations[job_id]

    def _publish(self, root, state, workspace, report):
        if not isinstance(report, dict) or set(report) - _REPORT_FIELDS:
            raise BrokerError("INVALID_REPORT")
        if any(report.get(key) is not True for key in ("approved", "reviewPassed")):
            raise BrokerError("REVIEW_REQUIRED")
        current = workspace.work_hash()
        if report.get("workHash") != current:
            raise BrokerError("STALE_HASH")
        matching = [check for check in state["checks"] if check.get("workHash") == current]
        required = set(workspace.changed_projects() or PROJECTS)
        trusted = [check for check in matching if check.get("passed") is True and check.get("complete") is True and check.get("exitCode") == 0
                   and check.get('checkProtocol') == CHECK_PROTOCOL and isinstance(check.get('coveredProjects'), list)
                   and all(isinstance(name, str) and name in PROJECTS for name in check['coveredProjects'])
                   and set(check['coveredProjects']) >= required]
        if not trusted or matching[-1].get("passed") is not True:
            raise BrokerError("CHECKS_REQUIRED")
        secured = {**report, "workHash": current, "approved": True, "reviewPassed": True, "checksPassed": True,
                   "checks": [{key: check[key] for key in ("passed", "complete", "workHash", "exitCode", "project", "summary", "coveredProjects", "checkProtocol")} for check in trusted[-1:]]}
        result = self.repository.publish(state["jobId"], root, state["meta"], workspace, secured)
        published = _publication(result, state["meta"]["branch"])
        state["publication"] = published
        state["status"] = "published"
        _private_json(root / "job.json", state)
        return published

    def _status(self, root, state):
        result = {"jobId": state["jobId"], "status": state.get("status", "ready"), **state["meta"],
                  "published": bool(state.get("publication")),
                  "checks": [{key: check.get(key) for key in ("passed", "complete", "workHash", "exitCode", "project", "checkedAt")}
                             for check in state["checks"][-5:]]}
        publication = state.get("publication")
        if publication:
            publication = _publication(publication, state["meta"]["branch"])
            if not publication.get("prUrl") and time.time() - state.get("prCheckedAt", 0) >= 30:
                try:
                    found = self.repository.lookup_pr(publication["commit"])
                    if isinstance(found, str) and re.fullmatch(r"https://github\.com/chixiaotao-Exm/Kook-Bot/pull/[1-9][0-9]*", found):
                        publication["prUrl"] = found
                except RepositoryError:
                    pass
                state["prCheckedAt"] = time.time()
                state["publication"] = publication
                _private_json(root / "job.json", state)
            result.update(publication)
        return result


def peer_allowed(connection, allowed_uids):
    try:
        if not hasattr(socket, "SO_PEERCRED"):
            return False
        credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _, uid, _ = struct.unpack("3i", credentials)
        return uid in allowed_uids
    except (OSError, ValueError, struct.error):
        return False


class RpcHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, format, *args):
        pass

    def _send(self, value, status=200):
        try:
            body = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            if len(body) > MAX_RESPONSE:
                body = b'{"ok":false,"error":{"code":"RESPONSE_LIMIT"}}'
                status = 413
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def do_POST(self):
        try:
            if not peer_allowed(self.connection, self.server.allowed_uids):
                raise BrokerError("NOT_AUTHORIZED")
            if self.path != "/rpc":
                raise BrokerError("NOT_FOUND")
            lengths = self.headers.get_all("Content-Length") or []
            if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,7}", lengths[0]) or self.headers.get("Transfer-Encoding"):
                raise BrokerError("INVALID_REQUEST")
            length = int(lengths[0])
            if length > MAX_REQUEST:
                raise BrokerError("REQUEST_LIMIT")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise BrokerError("INVALID_REQUEST")
            request = decode_request(raw)
            result = self.server.broker.dispatch(request["operation"], request["jobId"], request["args"])
            self._send({"ok": True, "data": result})
        except BrokerError as error:
            detail = {"code": error.code}
            if getattr(error, "cleanup_failed", False):
                detail["cleanupFailed"] = True
            self._send({"ok": False, "error": detail}, 403 if error.code == "NOT_AUTHORIZED" else 400)
        except Exception:
            self._send({"ok": False, "error": {"code": "BROKER_FAILED"}}, 500)

    def do_GET(self):
        self._send({"ok": False, "error": {"code": "NOT_FOUND"}}, 404)


class UnixRpcServer(socketserver.ThreadingMixIn, getattr(socketserver, "UnixStreamServer", socketserver.BaseServer)):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 32

    def __init__(self, socket_path, broker, allowed_uids, group_id=None):
        if not hasattr(socketserver, "UnixStreamServer"):
            raise BrokerError("UNIX_SOCKET_REQUIRED")
        self.broker, self.allowed_uids = broker, frozenset(allowed_uids)
        self.path = _no_links(socket_path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
        if self.path.exists():
            info = self.path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid():
                raise BrokerError("INVALID_SOCKET")
            self.path.unlink()
        super().__init__(str(self.path), RpcHandler)
        os.chmod(self.path, 0o660)
        if group_id is not None:
            os.chown(self.path, 0, group_id)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(15)
        return connection, address


def main():
    import pwd
    user = pwd.getpwnam(os.environ.get("CODE_AGENT_CLIENT_USER", "kook-duet"))
    home = os.environ.get("CODE_AGENT_HOME", "/var/lib/kook-code-agent")
    repository = RepositoryBackend(Path(home) / "repository", os.environ["CODE_AGENT_SSH_KEY"], os.environ["CODE_AGENT_KNOWN_HOSTS"])
    sandbox = SandboxRunner(image=os.environ.get("CODE_AGENT_IMAGE", "kook-code-sandbox:1"))
    broker = Broker(home, repository=repository, sandbox=sandbox)
    server = UnixRpcServer(os.environ.get("CODE_AGENT_SOCKET", "/run/kook-code-agent/broker.sock"), broker, {0, user.pw_uid}, user.pw_gid)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"event":"broker_start_failed"}', flush=True)
        raise SystemExit(1)
