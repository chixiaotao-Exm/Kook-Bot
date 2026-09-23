"""Bounded UTF-8 repository tools. Project files are data, never host programs."""
from __future__ import annotations

import difflib
import hashlib
import os
from pathlib import Path
import re
import stat
import tempfile

MAX_FILES = 1000
MAX_BYTES = 8 * 1024 * 1024
MAX_FILE_BYTES = 256 * 1024
MAX_READ_CHARS = 16_000
PROJECTS = ("ai-bot", "quota-dashboard", "music-bot", "code-agent")
_BLOCKED = {".git", ".kook-agent", "node_modules", "data", "release", "output", "deployed.md"}
_SECRET_NAMES = {".npmrc", ".pypirc", "id_rsa", "id_ed25519", "id_ecdsa", "credentials.json"}
_WINDOWS_DEVICE = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)
_HASH = re.compile(r"^[a-f0-9]{64}$")


class WorkspaceError(Exception):
    """A deliberately content-free error suitable for an untrusted tool client."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def validate_path(path: str, write: bool = False, allow_empty: bool = False) -> str:
    if not isinstance(path, str):
        raise WorkspaceError("INVALID_PATH")
    if path == "" and allow_empty:
        return path
    try:
        encoded_path = path.encode("utf-8")
    except UnicodeError:
        raise WorkspaceError("INVALID_PATH") from None
    if not path or len(encoded_path) > 1024 or path.startswith("/"):
        raise WorkspaceError("INVALID_PATH")
    if "\\" in path or re.search(r"[\x00-\x1f\x7f:*?\"<>|]", path):
        raise WorkspaceError("INVALID_PATH")
    parts = path.split("/")
    if len(parts) > 13:
        raise WorkspaceError("PATH_DEPTH")
    for part in parts:
        if (part in ("", ".", "..") or part.endswith((".", " "))
                or len(part.encode("utf-8")) > 255 or _WINDOWS_DEVICE.match(part)):
            raise WorkspaceError("INVALID_PATH")
        lowered = part.lower()
        if (lowered in _BLOCKED or lowered in _SECRET_NAMES
                or (lowered == ".env" or lowered.startswith(".env.")) and lowered != ".env.example"):
            raise WorkspaceError("PROTECTED_PATH")
        if write and lowered == ".github":
            raise WorkspaceError("PROTECTED_PATH")
    return path


def is_allowed_path(path: str, write: bool = False) -> bool:
    try:
        validate_path(path, write=write)
        return True
    except WorkspaceError:
        return False


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _text(data: bytes) -> str:
    if len(data) > MAX_FILE_BYTES:
        raise WorkspaceError("FILE_TOO_LARGE")
    try:
        decoded = data.decode("utf-8")
    except UnicodeError:
        raise WorkspaceError("NOT_TEXT") from None
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", decoded):
        raise WorkspaceError("NOT_TEXT")
    return decoded


class Workspace:
    """All access is rooted in a sanitized snapshot; callers hold the job lock."""

    validate_path = staticmethod(validate_path)
    is_allowed_path = staticmethod(is_allowed_path)

    def __init__(self, rootPath, baselinePath):
        self.root = self._trusted_root(rootPath)
        self.baseline_root = self._trusted_root(baselinePath)
        if (self.root == self.baseline_root or self.root in self.baseline_root.parents
                or self.baseline_root in self.root.parents):
            raise WorkspaceError("INVALID_ROOT")

    @staticmethod
    def _trusted_root(value):
        try:
            candidate = Path(value)
            info = candidate.lstat()
            if _is_link(info) or not stat.S_ISDIR(info.st_mode):
                raise WorkspaceError("INVALID_ROOT")
            return candidate.resolve(strict=True)
        except WorkspaceError:
            raise
        except (OSError, TypeError, ValueError):
            raise WorkspaceError("INVALID_ROOT") from None

    def _resolve(self, relative, *, write=False, root=None, allow_empty=False):
        relative = validate_path(relative, write=write, allow_empty=allow_empty)
        base = root or self.root
        current = base
        try:
            for part in relative.split("/") if relative else ():
                current = current / part
                try:
                    info = current.lstat()
                except FileNotFoundError:
                    continue
                if _is_link(info):
                    raise WorkspaceError("SYMLINK")
                if current != base / relative and not stat.S_ISDIR(info.st_mode):
                    raise WorkspaceError("NOT_DIRECTORY")
            return current
        except WorkspaceError:
            raise
        except (OSError, ValueError):
            raise WorkspaceError("IO_ERROR") from None

    def _inventory(self, root=None):
        base = root or self.root
        found = {}
        total = 0

        def visit(directory, prefix=""):
            nonlocal total
            try:
                entries = sorted(os.scandir(directory), key=lambda item: item.name)
                for item in entries:
                    relative = f"{prefix}/{item.name}" if prefix else item.name
                    if not is_allowed_path(relative):
                        continue
                    info = item.stat(follow_symlinks=False)
                    if _is_link(info):
                        raise WorkspaceError("SYMLINK")
                    if stat.S_ISDIR(info.st_mode):
                        if len(relative.split("/")) > 12:
                            raise WorkspaceError("PATH_DEPTH")
                        visit(Path(directory) / item.name, relative)
                    elif stat.S_ISREG(info.st_mode):
                        total += info.st_size
                        if len(found) >= MAX_FILES or total > MAX_BYTES:
                            raise WorkspaceError("WORKSPACE_LIMIT")
                        found[relative] = info.st_size
                    else:
                        raise WorkspaceError("UNSUPPORTED_FILE")
            except WorkspaceError:
                raise
            except OSError:
                raise WorkspaceError("IO_ERROR") from None

        visit(base)
        return found

    def _bytes(self, relative, *, root=None):
        file = self._resolve(relative, root=root)
        try:
            info = file.lstat()
            if _is_link(info):
                raise WorkspaceError("SYMLINK")
            if not stat.S_ISREG(info.st_mode):
                raise WorkspaceError("NOT_FILE")
            if info.st_size > MAX_BYTES:
                raise WorkspaceError("WORKSPACE_LIMIT")
            flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(file, flags), "rb") as stream:
                data = stream.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise WorkspaceError("WORKSPACE_LIMIT")
            return data
        except WorkspaceError:
            raise
        except FileNotFoundError:
            raise WorkspaceError("NOT_FOUND") from None
        except OSError:
            raise WorkspaceError("IO_ERROR") from None

    def _hash_inventory(self, inventory):
        digest = hashlib.sha256()
        for relative in sorted(inventory):
            name = relative.encode("utf-8")
            data = self._bytes(relative)
            digest.update(len(name).to_bytes(4, "big"))
            digest.update(name)
            digest.update(len(data).to_bytes(8, "big"))
            digest.update(hashlib.sha256(data).digest())
        return digest.hexdigest()

    def work_hash(self):
        return self._hash_inventory(self._inventory())

    def info(self):
        inventory = self._inventory()
        return {"fileCount": len(inventory), "totalBytes": sum(inventory.values()),
                "maxFiles": MAX_FILES, "maxBytes": MAX_BYTES, "maxFileBytes": MAX_FILE_BYTES,
                "projects": [project for project in PROJECTS if any(path.startswith(project + "/") for path in inventory)],
                "workHash": self._hash_inventory(inventory)}

    def list_files(self, path="", limit=200):
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_FILES:
            raise WorkspaceError("INVALID_LIMIT")
        folder = self._resolve(path, allow_empty=True)
        try:
            if not folder.is_dir():
                raise WorkspaceError("NOT_DIRECTORY")
        except OSError:
            raise WorkspaceError("IO_ERROR") from None
        inventory = self._inventory()
        matching = sorted(name for name in inventory if not path or name.startswith(path + "/"))
        files = []
        for name in matching[:limit]:
            data = self._bytes(name)
            try:
                _text(data)
                readable = True
            except WorkspaceError:
                readable = False
            files.append({"path": name, "size": len(data), "sha256": _digest(data),
                          "readable": readable, "writable": readable and is_allowed_path(name, write=True)})
        return {"path": path, "files": files, "total": len(matching), "truncated": len(matching) > limit}

    def read_file(self, path, start_line=1, max_lines=200):
        if (not isinstance(start_line, int) or isinstance(start_line, bool) or start_line < 1
                or not isinstance(max_lines, int) or isinstance(max_lines, bool) or not 1 <= max_lines <= 200):
            raise WorkspaceError("INVALID_LIMIT")
        data = self._bytes(path)
        source = _text(data)
        lines = source.splitlines()
        selected = []
        used = 0
        truncated = False
        for index in range(start_line - 1, min(len(lines), start_line - 1 + max_lines)):
            line = f"{index + 1}: {lines[index]}"
            remaining = MAX_READ_CHARS - used - (1 if selected else 0)
            if len(line) > remaining:
                if remaining > 0:
                    selected.append(line[:remaining])
                truncated = True
                break
            selected.append(line)
            used += len(line) + (1 if len(selected) > 1 else 0)
        end_line = start_line + len(selected) - 1 if selected else start_line - 1
        return {"path": path, "sha256": _digest(data), "size": len(data), "startLine": start_line,
                "endLine": end_line, "totalLines": len(lines), "content": "\n".join(selected),
                "truncated": truncated or end_line < len(lines)}

    def search_code(self, query, path="", max_results=50):
        if not isinstance(query, str) or not query or len(query) > 2000 or "\x00" in query:
            raise WorkspaceError("INVALID_QUERY")
        if not isinstance(max_results, int) or isinstance(max_results, bool) or not 1 <= max_results <= 100:
            raise WorkspaceError("INVALID_LIMIT")
        self._resolve(path, allow_empty=True)
        matches = []
        used = 0
        truncated = False
        for relative in sorted(self._inventory()):
            if path and relative != path and not relative.startswith(path + "/"):
                continue
            try:
                content = _text(self._bytes(relative))
            except WorkspaceError as error:
                if error.code in ("NOT_TEXT", "FILE_TOO_LARGE"):
                    continue
                raise
            for number, line in enumerate(content.splitlines(), 1):
                if query not in line:
                    continue
                if len(matches) >= max_results or used >= MAX_READ_CHARS:
                    truncated = True
                    break
                excerpt = line[:min(400, MAX_READ_CHARS - used)]
                matches.append({"path": relative, "line": number, "text": excerpt})
                used += len(excerpt)
            if truncated:
                break
        return {"matches": matches, "truncated": truncated}

    def write_file(self, path, content, expected_sha256=None):
        file = self._resolve(path, write=True)
        if not isinstance(content, str):
            raise WorkspaceError("INVALID_CONTENT")
        try:
            data = content.encode("utf-8")
        except UnicodeError:
            raise WorkspaceError("INVALID_CONTENT") from None
        _text(data)
        inventory = self._inventory()
        exists = path in inventory
        if exists:
            previous = self._bytes(path)
            _text(previous)
            if not isinstance(expected_sha256, str) or not _HASH.fullmatch(expected_sha256):
                raise WorkspaceError("HASH_REQUIRED")
            if _digest(previous) != expected_sha256:
                raise WorkspaceError("STALE_HASH")
        else:
            previous = b""
            if expected_sha256 is not None:
                raise WorkspaceError("STALE_HASH")
            if file.exists():
                raise WorkspaceError("NOT_FILE")
        if (len(inventory) + (0 if exists else 1) > MAX_FILES
                or sum(inventory.values()) - len(previous) + len(data) > MAX_BYTES):
            raise WorkspaceError("WORKSPACE_LIMIT")
        temporary = None
        try:
            current = self.root
            for part in path.split("/")[:-1]:
                current = current / part
                if not current.exists():
                    current.mkdir(mode=0o755)
                    os.chmod(current, 0o755)
                info = current.lstat()
                if _is_link(info) or not stat.S_ISDIR(info.st_mode):
                    raise WorkspaceError("SYMLINK")
            with tempfile.NamedTemporaryFile(dir=file.parent, prefix=".workspace-", suffix=".tmp", delete=False) as stream:
                temporary = stream.name
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o644)
            os.replace(temporary, file)
            temporary = None
        except WorkspaceError:
            raise
        except OSError:
            raise WorkspaceError("IO_ERROR") from None
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
        return {"path": path, "sha256": _digest(data), "size": len(data), "created": not exists}

    def replace_text(self, path, old_text, new_text, expected_sha256):
        self._resolve(path, write=True)
        if not isinstance(old_text, str) or not old_text or not isinstance(new_text, str):
            raise WorkspaceError("INVALID_REPLACEMENT")
        data = self._bytes(path)
        content = _text(data)
        if not isinstance(expected_sha256, str) or not _HASH.fullmatch(expected_sha256):
            raise WorkspaceError("HASH_REQUIRED")
        if _digest(data) != expected_sha256:
            raise WorkspaceError("STALE_HASH")
        first = content.find(old_text)
        if first < 0:
            raise WorkspaceError("MATCH_NOT_FOUND")
        if content.find(old_text, first + 1) >= 0:
            raise WorkspaceError("MATCH_NOT_UNIQUE")
        return self.write_file(path, content.replace(old_text, new_text, 1), expected_sha256)

    def get_diff(self, path=None, max_chars=40_000):
        if not isinstance(max_chars, int) or isinstance(max_chars, bool) or not 1 <= max_chars <= 40_000:
            raise WorkspaceError("INVALID_LIMIT")
        if path is not None:
            validate_path(path)
        current, baseline = self._inventory(), self._inventory(self.baseline_root)
        files, chunks, used, truncated = [], [], 0, False
        for relative in sorted(set(current) | set(baseline)):
            if path is not None and relative != path and not relative.startswith(path + "/"):
                continue
            before = self._bytes(relative, root=self.baseline_root) if relative in baseline else None
            after = self._bytes(relative) if relative in current else None
            if before == after:
                continue
            binary = False
            try:
                left = _text(before or b"").splitlines(keepends=True)
                right = _text(after or b"").splitlines(keepends=True)
            except WorkspaceError as error:
                if error.code not in ("NOT_TEXT", "FILE_TOO_LARGE"):
                    raise
                binary = True
            files.append({"path": relative, "status": "added" if before is None else "deleted" if after is None else "modified",
                          "beforeSha256": _digest(before) if before is not None else None,
                          "afterSha256": _digest(after) if after is not None else None, "binary": binary})
            lines = [f"Binary or unsupported text differs: {relative}\n"] if binary else difflib.unified_diff(
                left, right, fromfile="a/" + relative if before is not None else "/dev/null",
                tofile="b/" + relative if after is not None else "/dev/null")
            for line in lines:
                if used >= max_chars:
                    truncated = True
                    break
                remaining = max_chars - used
                chunks.append(line[:remaining])
                used += min(len(line), remaining)
                if len(line) > remaining:
                    truncated = True
                    break
        return {"files": files, "diff": "".join(chunks), "truncated": truncated,
                "workHash": self._hash_inventory(current), "changedProjects": self._projects(files)}

    @staticmethod
    def _projects(files):
        if any(item["path"].split("/", 1)[0] not in PROJECTS for item in files):
            return list(PROJECTS)
        return [project for project in PROJECTS if any(item["path"].startswith(project + "/") for item in files)]

    def changed_projects(self):
        return self.get_diff(max_chars=1)["changedProjects"]
