"""Trusted, fixed-repository Git operations outside the model workspace."""

from __future__ import annotations

import hashlib
import html
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import subprocess
import tarfile
import threading
import time
from urllib.parse import quote, urlencode
import uuid


REPOSITORY = "chixiaotao-Exm/Kook-Bot"
REMOTE = "ssh://git@ssh.github.com:443/chixiaotao-Exm/Kook-Bot.git"
WEB = "https://github.com/" + REPOSITORY
MAX_FILES = 1000
MAX_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE = 16 * 1024 * 1024
SHA = re.compile(r"^[0-9a-f]{40}$")
HASH = re.compile(r"^[0-9a-f]{64}$")
EXCLUDED_DIRS = {".git", ".kook-agent", ".ssh", "node_modules", "data", "release", "output",
                 "private", "ops", "operations", "backups", "__pycache__", ".venv", "venv"}
EXCLUDED_NAMES = {"deployed.md", ".gitmodules", ".gitconfig", ".npmrc", ".pypirc", "credentials.json",
                  "credentials", "id_rsa", "id_ed25519", "authorized_keys", "known_hosts"}
SECRET = re.compile(r"(?:\bsk-[A-Za-z0-9_-]{12,}|\badmin-[A-Za-z0-9_-]{16,}|"
                    r"\b\d{1,4}/[A-Za-z0-9+/=]{4,}/[A-Za-z0-9+/=]{10,}|"
                    r"-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----)")


class RepositoryError(Exception):
    """Only stable codes cross the broker boundary; never expose Git stderr."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _job_id(value):
    try:
        parsed = uuid.UUID(value)
        if str(parsed) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise RepositoryError("INVALID_JOB") from None
    return value


def _relative(value):
    if not isinstance(value, str) or not value or len(value) > 512 or "\\" in value or ":" in value:
        raise RepositoryError("UNSAFE_PATH")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise RepositoryError("UNSAFE_PATH")
    pieces = value.split("/")
    if value.startswith("/") or any(piece in {"", ".", ".."} for piece in pieces):
        raise RepositoryError("UNSAFE_PATH")
    return PurePosixPath(value).as_posix()


def _exportable(value):
    pieces = PurePosixPath(value).parts
    if any(piece.lower() in EXCLUDED_DIRS for piece in pieces):
        return False
    name = pieces[-1].lower()
    if name in EXCLUDED_NAMES or name.endswith((".pem", ".key", ".p12", ".pfx", ".log")):
        return False
    env_file = name == ".env" or name.startswith(".env.") or name.endswith(".env") or ".env." in name
    return not env_file or name.endswith(".example")


def _no_links(path):
    path = Path(os.path.abspath(os.fspath(path)))
    for part in (path, *path.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise RepositoryError("UNSAFE_PATH")
    return path


def _mkdir(path):
    path = _no_links(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    _no_links(path)
    if not path.is_dir():
        raise RepositoryError("UNSAFE_PATH")
    return path


def _read_regular(root, relative, limit=MAX_BYTES, missing=False):
    """Do not follow links, including intermediate components on POSIX."""
    relative = _relative(relative)
    root = _no_links(root)
    path = _no_links(root.joinpath(*PurePosixPath(relative).parts))
    descriptors = []
    try:
        if os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW"):
            directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptors.append(directory)
            for component in PurePosixPath(relative).parts[:-1]:
                directory = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                descriptors.append(directory)
            descriptor = os.open(PurePosixPath(relative).name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        else:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
        descriptors.append(descriptor)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise RepositoryError("UNSAFE_FILE")
        parts = []
        size = 0
        while True:
            data = os.read(descriptor, min(65536, limit + 1 - size))
            if not data:
                break
            size += len(data)
            if size > limit:
                raise RepositoryError("FILE_LIMIT")
            parts.append(data)
        return b"".join(parts)
    except FileNotFoundError:
        if missing:
            return None
        raise RepositoryError("MISSING_FILE") from None
    except OSError:
        raise RepositoryError("UNSAFE_FILE") from None
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _write_file(root, relative, data, new=False, mode=0o600):
    relative = _relative(relative)
    root = _no_links(root)
    destination = _no_links(root.joinpath(*PurePosixPath(relative).parts))
    _mkdir(destination.parent)
    if destination.exists():
        info = destination.lstat()
        if new or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RepositoryError("UNSAFE_FILE")
    temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), mode)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def _default_runner(argv, *, cwd, env, timeout, max_output_bytes):
    """A subprocess runner with bounded stdout/stderr, no shell and no stdin."""
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
    except OSError:
        raise RepositoryError("GIT_UNAVAILABLE") from None
    outputs = [bytearray(), bytearray()]
    overflow = threading.Event()

    def drain(stream, target, maximum):
        try:
            while True:
                part = stream.read(65536)
                if not part:
                    break
                if len(target) + len(part) > maximum:
                    overflow.set()
                    try:
                        process.kill()
                    except OSError:
                        pass
                    break
                target.extend(part)
        finally:
            stream.close()

    threads = [threading.Thread(target=drain, args=(process.stdout, outputs[0], max_output_bytes), daemon=True),
               threading.Thread(target=drain, args=(process.stderr, outputs[1], 65536), daemon=True)]
    for thread in threads:
        thread.start()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
        raise RepositoryError("GIT_TIMEOUT") from None
    finally:
        for thread in threads:
            thread.join(timeout=5)
    if overflow.is_set() or any(thread.is_alive() for thread in threads):
        raise RepositoryError("GIT_OUTPUT_LIMIT")
    return subprocess.CompletedProcess(argv, process.returncode, bytes(outputs[0]), bytes(outputs[1]))


def _safe_text(value, maximum):
    if not isinstance(value, str):
        return ""
    value = SECRET.sub("[redacted]", value[:maximum * 4])
    value = " ".join(value.split())
    return "".join(char for char in value if ord(char) >= 32 and ord(char) != 127)[:maximum]


def _markdown(value):
    # Escape generated model prose as text, including autolink punctuation.
    value = html.escape(value, quote=False)
    return re.sub(r"([\\`*_{}\[\]()#+.!|>~:<>=/\-])", r"\\\1", value)


def _bounded_markdown(lines, report_json_path):
    text = "\n".join(lines) + "\n"
    if len(text.encode("utf-16-le")) // 2 <= 28000:
        return text.encode("utf-8")
    marker = f"\n\n摘要过长，已截断。完整复核记录见 {report_json_path}。\n"
    budget = 28000 - len(marker.encode("utf-16-le")) // 2
    kept = []
    used = 0
    for line in lines:
        units = len((line + "\n").encode("utf-16-le")) // 2
        if used + units > budget:
            break
        kept.append(line)
        used += units
    # Truncate only at already-escaped line boundaries: never cut an escape pair
    # into a new Markdown construct, and count astral characters as two units.
    return ("\n".join(kept) + "\n" + marker).encode("utf-8")


class RepositoryBackend:
    def __init__(self, root_dir, ssh_key, known_hosts, git="/usr/bin/git", runner=None):
        self.root = _mkdir(root_dir)
        self.ssh_key = _no_links(ssh_key)
        self.known_hosts = _no_links(known_hosts)
        for configured in (str(self.ssh_key), str(self.known_hosts), str(git)):
            if "\n" in configured or "\r" in configured or "\0" in configured:
                raise RepositoryError("INVALID_CONFIG")
        if not Path(git).is_absolute():
            raise RepositoryError("INVALID_CONFIG")
        self.git = str(git)
        self.runner = runner or _default_runner
        self._lock = threading.RLock()
        self.home = _mkdir(self.root / "git-home")
        self.mirror = self.root / "mirror.git"
        for directory in ("prepared", "published", "publish"):
            _mkdir(self.root / directory)

    def _environment(self, extra=None):
        ssh = ["/usr/bin/ssh", "-F", "/dev/null", "-i", str(self.ssh_key),
               "-o", "UserKnownHostsFile=" + str(self.known_hosts), "-o", "GlobalKnownHostsFile=/dev/null",
               "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
               "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
               "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no"]
        environment = {"PATH": os.path.dirname(self.git) + os.pathsep + os.defpath,
                       "HOME": str(self.home), "XDG_CONFIG_HOME": str(self.home), "LC_ALL": "C", "LANG": "C",
                       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
                       "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/bin/false", "SSH_ASKPASS": "/bin/false",
                       "GIT_ATTR_NOSYSTEM": "1", "GIT_SSH_COMMAND": shlex.join(ssh), "GIT_SSH_VARIANT": "ssh"}
        if os.name == "nt" and os.environ.get("SystemRoot"):
            environment["SystemRoot"] = os.environ["SystemRoot"]
        if extra:
            environment.update(extra)
        return environment

    def _run(self, args, *, cwd=None, maximum=128 * 1024, timeout=60, extra_env=None):
        options = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "core.untrackedCache=false",
                   "core.attributesFile=/dev/null", "core.autocrlf=false", "commit.gpgSign=false", "tag.gpgSign=false",
                   "gc.auto=0", "maintenance.auto=false", "protocol.allow=never", "protocol.ssh.allow=always"]
        command = [self.git]
        for option in options:
            command.extend(["-c", option])
        command.extend(args)
        try:
            result = self.runner(command, cwd=str(cwd or self.root), env=self._environment(extra_env),
                                 timeout=timeout, max_output_bytes=maximum)
        except RepositoryError:
            raise
        except Exception:
            raise RepositoryError("GIT_FAILED") from None
        output = result.stdout
        if isinstance(output, str):
            output = output.encode("utf-8")
        if not isinstance(output, bytes) or len(output) > maximum:
            raise RepositoryError("GIT_OUTPUT_LIMIT")
        if result.returncode != 0:
            raise RepositoryError("GIT_FAILED")
        return output

    def _mirror_run(self, args, **options):
        return self._run(["--git-dir=" + str(self.mirror), *args], **options)

    def _record(self, directory, job_id):
        raw = _read_regular(self.root, f"{directory}/{job_id}.json", missing=True)
        if raw is None:
            return None
        try:
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, UnicodeError):
            raise RepositoryError("INVALID_STATE") from None

    def prepare(self, job_id, job_root):
        job_id = _job_id(job_id)
        job_root = _mkdir(job_root)
        with self._lock:
            previous = self._record("prepared", job_id)
            if previous is not None:
                if previous.get("jobRoot") != str(job_root):
                    raise RepositoryError("JOB_CONFLICT")
                return {key: previous[key] for key in ("repository", "baseSha", "branch")}
            for name in ("baseline", "work"):
                if (job_root / name).exists() or (job_root / name).is_symlink():
                    raise RepositoryError("WORKSPACE_EXISTS")
            if not self.mirror.exists():
                self._run(["init", "--bare", str(self.mirror)])
            _no_links(self.mirror)
            self._mirror_run(["fetch", "--no-tags", "--no-recurse-submodules", REMOTE,
                              "+refs/heads/main:refs/heads/source-main"], timeout=120)
            base = self._mirror_run(["rev-parse", "--verify", "refs/heads/source-main^{commit}"]).decode("ascii").strip()
            if not SHA.fullmatch(base):
                raise RepositoryError("INVALID_BASE")
            # Reports are preserved in the publication tree, but are never model
            # inputs. Exclude their history before applying the archive budget.
            archive = self._mirror_run(["archive", "--format=tar", base, "--", ".", ":(exclude).kook-agent"], maximum=MAX_ARCHIVE)
            files = {}
            file_modes = {}
            archive_paths = set()
            size = 0
            try:
                with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as stream:
                    for member in stream:
                        name = _relative(member.name.rstrip("/") if member.isdir() else member.name)
                        key = name.casefold()
                        if key in archive_paths:
                            raise RepositoryError("UNSAFE_ARCHIVE")
                        archive_paths.add(key)
                        if not (member.isdir() or member.isfile()) or member.issym() or member.islnk():
                            raise RepositoryError("UNSAFE_ARCHIVE")
                        if member.isdir() or not _exportable(name):
                            continue
                        if member.size < 0 or member.size > MAX_BYTES or len(files) >= MAX_FILES:
                            raise RepositoryError("REPOSITORY_LIMIT")
                        size += member.size
                        if size > MAX_BYTES:
                            raise RepositoryError("REPOSITORY_LIMIT")
                        extracted = stream.extractfile(member)
                        data = extracted.read(member.size + 1) if extracted else b""
                        if len(data) != member.size:
                            raise RepositoryError("UNSAFE_ARCHIVE")
                        files[name] = data
                        file_modes[name] = 0o755 if member.mode & 0o111 else 0o644
            except (tarfile.TarError, OSError, UnicodeError):
                raise RepositoryError("UNSAFE_ARCHIVE") from None
            for name in ("baseline", "work"):
                directory = _mkdir(job_root / name)
                for relative, data in files.items():
                    _write_file(directory, relative, data, new=True, mode=file_modes[relative])
                # The bind mount is read by the unprivileged test-container UID;
                # the enclosing job directory remains private on the host.
                for current, _directories, _files in os.walk(directory, followlinks=False):
                    os.chmod(current, 0o755)
            record = {"repository": REPOSITORY, "baseSha": base, "branch": "kook-agent/task-" + job_id,
                      "jobRoot": str(job_root), "createdAt": int(time.time()),
                      "manifest": {relative: hashlib.sha256(data).hexdigest() for relative, data in files.items()}}
            _write_file(self.root, f"prepared/{job_id}.json", _json_bytes(record), new=True)
            return {key: record[key] for key in ("repository", "baseSha", "branch")}

    @staticmethod
    def _allowed(workspace, relative, write=True):
        relative = _relative(relative)
        if not _exportable(relative) or (write and any(part.lower() == ".github" for part in PurePosixPath(relative).parts)):
            raise RepositoryError("PROTECTED_PATH")
        validator = getattr(workspace, "is_allowed_path", None)
        if validator is None:
            from .workspace import is_allowed_path
            validator = is_allowed_path
        if not validator(relative, write=write):
            raise RepositoryError("PROTECTED_PATH")
        return relative

    def _report(self, job_id, meta, workspace, report, work_hash):
        if not isinstance(report, dict) or any(report.get(key) is not True for key in ("approved", "checksPassed", "reviewPassed")):
            raise RepositoryError("REPORT_NOT_APPROVED")
        if not isinstance(work_hash, str) or report.get("workHash") != work_hash or not HASH.fullmatch(work_hash):
            raise RepositoryError("STALE_REPORT")
        checks = report.get("checks")
        if not isinstance(checks, list) or not 1 <= len(checks) <= 30:
            raise RepositoryError("CHECKS_REQUIRED")
        safe_checks = []
        for check in checks:
            if not isinstance(check, dict) or check.get("passed") is not True or check.get("complete") is not True or check.get("workHash") != work_hash:
                raise RepositoryError("CHECKS_NOT_PASSED")
            safe = {"passed": True, "complete": True, "workHash": work_hash,
                    "name": _safe_text(check.get("name", check.get("profile", "Repository checks")), 100)}
            if type(check.get("exitCode")) is int:
                if check["exitCode"] != 0:
                    raise RepositoryError("CHECKS_NOT_PASSED")
                safe["exitCode"] = 0
            safe_checks.append(safe)
        review = report.get("review", {})
        if not isinstance(review, dict):
            raise RepositoryError("INVALID_REPORT")
        findings = review.get("findings", [])
        if not isinstance(findings, list) or len(findings) > 30:
            raise RepositoryError("INVALID_REPORT")
        safe_findings = []
        for finding in findings:
            if not isinstance(finding, dict):
                raise RepositoryError("INVALID_REPORT")
            severity = str(finding.get("severity", "info")).lower()
            if severity not in {"critical", "high", "medium", "low", "info", "p0", "p1", "p2", "p3"}:
                severity = "info"
            safe = {"severity": severity, "description": _safe_text(finding.get("description"), 1600),
                    "solution": _safe_text(finding.get("solution"), 1600)}
            if finding.get("path"):
                safe["path"] = self._allowed(workspace, finding["path"], write=False)
            if type(finding.get("line")) is int and 1 <= finding["line"] <= 1000000:
                safe["line"] = finding["line"]
            safe_findings.append(safe)
        safe = {"version": 1, "jobId": job_id, **meta, "approved": True, "checksPassed": True,
                "reviewPassed": True, "workHash": work_hash, "checks": safe_checks,
                "review": {"summary": _safe_text(review.get("summary"), 4000), "findings": safe_findings}}
        operator = report.get("operatorId")
        if isinstance(operator, str) and re.fullmatch(r"[0-9]{5,30}", operator):
            safe["operatorId"] = operator
        lines = ["# Agent task report", "", f"Task: `{job_id}`", f"Repository: `{REPOSITORY}`",
                 f"Base: `{meta['baseSha']}`", f"Work hash: `{work_hash}`", "", "## Validation", ""]
        lines.extend("- Passed: " + _markdown(check["name"]) for check in safe_checks)
        lines.extend(["", "## Review", "", _markdown(safe["review"]["summary"]), "", "## Findings", ""])
        for index, finding in enumerate(safe_findings, 1):
            lines.append(f"{index}. " + _markdown(finding["severity"] + ": " + finding["description"]))
            if finding.get("path"):
                lines.append("   File: " + _markdown(finding["path"] + (":" + str(finding["line"]) if finding.get("line") else "")))
            lines.append("   Suggested change: " + _markdown(finding["solution"]))
        if not safe_findings:
            lines.append("No findings recorded.")
        report_root = f".kook-agent/reports/{job_id}"
        report_json = report_root + "/report.json"
        return {report_json: _json_bytes(safe), report_root + "/report.md": _bounded_markdown(lines, report_json)}

    def _remote_branch(self, branch):
        output = self._mirror_run(["ls-remote", "--heads", REMOTE, "refs/heads/" + branch], timeout=20)
        found = []
        for line in output.decode("utf-8", errors="strict").splitlines():
            parts = line.split()
            if len(parts) != 2 or not SHA.fullmatch(parts[0]) or parts[1] != "refs/heads/" + branch:
                raise RepositoryError("INVALID_REMOTE_RESPONSE")
            found.append(parts[0])
        if len(found) > 1:
            raise RepositoryError("INVALID_REMOTE_RESPONSE")
        return found[0] if found else None

    @staticmethod
    def _publication(branch, commit):
        return {"published": True, "repository": REPOSITORY, "branch": branch, "commit": commit,
                "compareUrl": WEB + "/compare/main..." + quote(branch, safe="") + "?expand=1",
                "prLookupUrl": WEB + "/pulls?" + urlencode({"q": "is:pr head:" + branch})}

    def publish(self, job_id, job_root, meta, workspace, report):
        job_id = _job_id(job_id)
        job_root = _no_links(job_root)
        with self._lock:
            prepared = self._record("prepared", job_id)
            canonical = {key: prepared.get(key) for key in ("repository", "baseSha", "branch")} if prepared else None
            if not prepared or canonical != meta or prepared.get("jobRoot") != str(job_root):
                raise RepositoryError("INVALID_PREPARED_STATE")
            if _no_links(workspace.root) != job_root / "work" or _no_links(workspace.baseline_root) != job_root / "baseline":
                raise RepositoryError("WORKSPACE_MISMATCH")
            work_hash = workspace.work_hash()
            reports = self._report(job_id, canonical, workspace, report, work_hash)
            diff = workspace.get_diff()
            if not isinstance(diff, dict) or diff.get("workHash") != work_hash or not isinstance(diff.get("files"), list):
                raise RepositoryError("STALE_DIFF")
            if not 1 <= len(diff["files"]) <= MAX_FILES:
                raise RepositoryError("NO_CHANGES" if not diff["files"] else "REPOSITORY_LIMIT")
            changes = {}
            total = 0
            for item in diff["files"]:
                if not isinstance(item, dict):
                    raise RepositoryError("INVALID_DIFF")
                name = self._allowed(workspace, item.get("path"))
                if name.casefold() in {value.casefold() for value in changes}:
                    raise RepositoryError("INVALID_DIFF")
                before = _read_regular(workspace.baseline_root, name, missing=True)
                after = _read_regular(workspace.root, name, missing=True)
                before_hash = hashlib.sha256(before).hexdigest() if before is not None else None
                after_hash = hashlib.sha256(after).hexdigest() if after is not None else None
                expected_status = "added" if before is None else "deleted" if after is None else "modified"
                if before_hash != prepared["manifest"].get(name) or before_hash != item.get("beforeSha256") or after_hash != item.get("afterSha256"):
                    raise RepositoryError("STALE_DIFF")
                if before_hash == after_hash or item.get("status") != expected_status:
                    raise RepositoryError("INVALID_DIFF")
                # Archive attributes can hide or substitute tracked files. An
                # apparent addition must never overwrite an undisclosed base
                # blob, and the reviewed baseline must match Git's raw content.
                tree_entry = self._mirror_run(["--literal-pathspecs", "ls-tree", "-z", canonical["baseSha"], "--", name])
                if tree_entry:
                    try:
                        descriptor, tree_name = tree_entry.rstrip(b"\0").split(b"\t", 1)
                        mode, kind, object_id = descriptor.decode("ascii").split()
                        if tree_name.decode("utf-8") != name or mode not in {"100644", "100755"} or kind != "blob" or not SHA.fullmatch(object_id):
                            raise ValueError()
                    except (ValueError, UnicodeError):
                        raise RepositoryError("INVALID_BASE") from None
                    raw_base = self._mirror_run(["cat-file", "blob", object_id], maximum=MAX_BYTES)
                    if hashlib.sha256(raw_base).hexdigest() != before_hash:
                        raise RepositoryError("STALE_DIFF")
                elif before is not None:
                    raise RepositoryError("STALE_DIFF")
                total += len(after) if after is not None else 0
                if total > MAX_BYTES:
                    raise RepositoryError("REPOSITORY_LIMIT")
                changes[name] = after
            if workspace.work_hash() != work_hash:
                raise RepositoryError("STALE_REPORT")
            published = self._record("published", job_id)
            remote = self._remote_branch(canonical["branch"])
            if published:
                if published.get("workHash") != work_hash or not SHA.fullmatch(published.get("commit", "")):
                    raise RepositoryError("PUBLISH_CONFLICT")
                if remote == published["commit"]:
                    published["published"] = True
                    _write_file(self.root, f"published/{job_id}.json", _json_bytes(published))
                    return self._publication(canonical["branch"], published["commit"])
                if remote is not None or published.get("published"):
                    raise RepositoryError("PUBLISH_CONFLICT")
                commit = published["commit"]
            else:
                if remote is not None:
                    raise RepositoryError("BRANCH_EXISTS")
                job_publish = _mkdir(self.root / "publish" / job_id)
                checkout = job_publish / ("work-" + uuid.uuid4().hex)
                self._mirror_run(["worktree", "add", "--detach", str(checkout), canonical["baseSha"]])
                for name, data in {**changes, **reports}.items():
                    if data is None:
                        _read_regular(checkout, name)
                        _no_links(checkout.joinpath(*PurePosixPath(name).parts)).unlink()
                    else:
                        destination = _no_links(checkout.joinpath(*PurePosixPath(name).parts))
                        mode = 0o755 if destination.exists() and destination.stat().st_mode & 0o111 else 0o644
                        _write_file(checkout, name, data, mode=mode)
                paths = sorted([*changes, *reports])
                self._run(["--literal-pathspecs", "add", "--", *paths], cwd=checkout)
                staged = self._run(["diff", "--cached", "--name-only", "--no-renames", "-z"], cwd=checkout)
                if set(staged.decode("utf-8").rstrip("\0").split("\0")) != set(paths):
                    raise RepositoryError("UNEXPECTED_STAGED_FILES")
                for name, data in {**changes, **reports}.items():
                    if data is not None:
                        staged_data = self._run(["cat-file", "blob", ":" + name], cwd=checkout, maximum=MAX_BYTES)
                        if staged_data != data:
                            raise RepositoryError("STAGED_CONTENT_MISMATCH")
                if workspace.work_hash() != work_hash:
                    raise RepositoryError("STALE_REPORT")
                timestamp = str(prepared["createdAt"]) + " +0000"
                identity = {"GIT_AUTHOR_NAME": "KOOK Code Agent", "GIT_COMMITTER_NAME": "KOOK Code Agent",
                            "GIT_AUTHOR_EMAIL": "kook-code-agent@users.noreply.github.com",
                            "GIT_COMMITTER_EMAIL": "kook-code-agent@users.noreply.github.com",
                            "GIT_AUTHOR_DATE": timestamp, "GIT_COMMITTER_DATE": timestamp}
                self._run(["commit", "--no-verify", "--no-gpg-sign", "-m", "Agent task " + job_id], cwd=checkout, extra_env=identity)
                parents = self._run(["rev-list", "--parents", "-n", "1", "HEAD"], cwd=checkout).decode("ascii").split()
                if len(parents) != 2 or not SHA.fullmatch(parents[0]) or parents[1] != canonical["baseSha"]:
                    raise RepositoryError("INVALID_COMMIT")
                commit = parents[0]
                published = {"published": False, "commit": commit, "branch": canonical["branch"], "workHash": work_hash}
                _write_file(self.root, f"published/{job_id}.json", _json_bytes(published), new=True)
            self._mirror_run(["push", "--porcelain", REMOTE, commit + ":refs/heads/" + canonical["branch"]], timeout=120)
            if self._remote_branch(canonical["branch"]) != commit:
                raise RepositoryError("PUSH_UNCONFIRMED")
            published["published"] = True
            _write_file(self.root, f"published/{job_id}.json", _json_bytes(published))
            return self._publication(canonical["branch"], commit)

    def lookup_pr(self, commit):
        if not isinstance(commit, str) or not SHA.fullmatch(commit):
            raise RepositoryError("INVALID_COMMIT")
        with self._lock:
            result = self._run(["ls-remote", REMOTE, "refs/pull/*/head"], maximum=2 * 1024 * 1024, timeout=20)
        matches = []
        for line in result.decode("utf-8", errors="strict").splitlines():
            match = re.fullmatch(r"([0-9a-f]{40})\s+refs/pull/([1-9][0-9]{0,9})/head", line)
            if match and match[1] == commit:
                matches.append(int(match[2]))
        return WEB + "/pull/" + str(min(matches)) if matches else None
