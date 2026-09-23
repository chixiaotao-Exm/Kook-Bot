"""Run fixed test entrypoints in a restricted, disposable Docker container."""
from __future__ import annotations

import os
from pathlib import PurePosixPath
import re
import subprocess
import threading
import time
import uuid

from .workspace import PROJECTS, WorkspaceError, validate_path

MAX_OUTPUT_BYTES = 64 * 1024
_TRUNCATION = b"\n... [output truncated] ...\n"
_DEPENDENCIES = {"package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
                 "pyproject.toml", "poetry.lock", "pipfile", "pipfile.lock", "uv.lock", "setup.py", "setup.cfg"}
_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "HOME": "/nonexistent"}


class _Output:
    def __init__(self):
        self.buffer = bytearray()
        self.head = b""
        self.tail = b""
        self.truncated = False
        self.failed = False

    def drain(self, stream):
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                if not isinstance(chunk, bytes):
                    self.failed = True
                    break
                self.add(chunk)
        except (OSError, ValueError):
            self.failed = True

    def add(self, chunk):
        head_limit = (MAX_OUTPUT_BYTES - len(_TRUNCATION)) // 2
        tail_limit = MAX_OUTPUT_BYTES - len(_TRUNCATION) - head_limit
        if not self.truncated:
            if len(self.buffer) + len(chunk) <= MAX_OUTPUT_BYTES:
                self.buffer.extend(chunk)
                return
            combined = bytes(self.buffer) + chunk
            self.head, self.tail = combined[:head_limit], combined[-tail_limit:]
            self.buffer.clear()
            self.truncated = True
        else:
            self.tail = (self.tail + chunk)[-tail_limit:]

    def text(self):
        output = self.head + _TRUNCATION + self.tail if self.truncated else bytes(self.buffer)
        decoded = output.decode("utf-8", errors="replace")
        encoded = decoded.encode("utf-8")
        if len(encoded) > MAX_OUTPUT_BYTES:
            self.truncated = True
            head_limit = (MAX_OUTPUT_BYTES - len(_TRUNCATION)) // 2
            tail_limit = MAX_OUTPUT_BYTES - len(_TRUNCATION) - head_limit
            return encoded[:head_limit].decode("utf-8", errors="ignore") + _TRUNCATION.decode() + encoded[-tail_limit:].decode("utf-8", errors="ignore")
        return decoded


class SandboxRunner:
    def __init__(self, config=None, *, image="kook-code-sandbox:1", docker="/usr/bin/docker", timeout=180):
        if config is not None:
            if not isinstance(config, dict):
                raise ValueError("INVALID_CONFIG")
            image, docker, timeout = config.get("image", image), config.get("docker", docker), config.get("timeout", timeout)
        if (not isinstance(image, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]{0,200}", image)
                or not isinstance(docker, str) or not docker.startswith("/") or re.search(r"[\x00-\x1f]", docker)
                or not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0 < timeout <= 600):
            raise ValueError("INVALID_CONFIG")
        self.image, self.docker, self.timeout = image, docker, float(timeout)

    def _remove(self, name):
        # Names are generated here, never supplied by the model or source tree.
        if not re.fullmatch(r"kook-code-[a-f0-9]{32}", name):
            return
        try:
            subprocess.run([self.docker, "rm", "-f", name], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=10, check=False, env=_ENV.copy())
        except (OSError, subprocess.SubprocessError):
            pass

    @staticmethod
    def _validate_tests(workspace, project, test_files):
        if project not in ("all", *PROJECTS):
            raise WorkspaceError("INVALID_PROJECT")
        if not isinstance(test_files, list) or len(test_files) > 50 or project == "all" and test_files:
            raise WorkspaceError("INVALID_TEST_FILES")
        result = []
        for value in test_files:
            value = validate_path(value)
            parts = value.split("/")
            # Repository tools return paths rooted at the checkout. Accept that
            # spelling only for this project, then keep the image's existing
            # project-relative argv contract.
            if parts[0] == project:
                parts = parts[1:]
                value = "/".join(parts)
            if len(parts) < 2 or parts[0] not in ("test", "tests"):
                raise WorkspaceError("INVALID_TEST_FILES")
            name = parts[-1]
            valid = name.startswith("test_") and name.endswith(".py") if project == "code-agent" else name.endswith((".test.js", ".test.cjs", ".test.mjs", ".spec.js", ".spec.cjs", ".spec.mjs"))
            if not valid or project == "code-agent" and any("." in part for part in [*parts[:-1], name[:-3]]):
                raise WorkspaceError("INVALID_TEST_FILES")
            if project != "code-agent" and re.search(r"[\[\]{}()]", value):
                raise WorkspaceError("INVALID_TEST_FILES")
            workspace.read_file(f"{project}/{value}", max_lines=1)
            if value not in result:
                result.append(value)
        return result

    def run(self, workspace, project="all", test_files=None, cancel_event=None):
        result = {"passed": False, "exitCode": None, "summary": "测试未执行。", "output": "",
                  "truncated": False, "project": project if project in ("all", *PROJECTS) else "all",
                  "complete": False, "workHash": None}
        try:
            test_files = self._validate_tests(workspace, project, [] if test_files is None else test_files)
            source = str(workspace.root)
            if any(character in source for character in (",", '"', "\n", "\r", "\x00")):
                raise WorkspaceError("INVALID_ROOT")
            result["workHash"] = workspace.work_hash()
            changed = workspace.get_diff(max_chars=1)
            for item in changed["files"]:
                name = PurePosixPath(item["path"]).name.lower()
                if name in _DEPENDENCIES or re.fullmatch(r"requirements(?:[._-].*)?\.txt", name):
                    return {**result, "summary": "依赖声明已修改，当前沙箱未准备这些依赖。", "errorCode": "DEPENDENCY_CHANGED"}
            changed_projects = set(changed["changedProjects"])
        except WorkspaceError as error:
            return {**result, "summary": "测试请求或工作区无效。", "errorCode": error.code}
        if cancel_event is not None and cancel_event.is_set():
            return {**result, "summary": "测试已取消。", "errorCode": "CANCELLED"}
        name = "kook-code-" + uuid.uuid4().hex
        command = [self.docker, "run", "--name", name, "--rm", "--network", "none", "--read-only",
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128",
                   "--memory", "768m", "--memory-swap", "768m", "--cpus", "1", "--user", "1000:1000",
                   "--tmpfs", "/work:rw,size=128m,mode=1777", "--tmpfs", "/tmp:rw,size=64m,mode=1777",
                   "--mount", f"type=bind,source={source},target=/input,readonly",
                   self.image, "/usr/local/bin/run-checks", project, *test_files]
        process, reader, error_code = None, None, None
        output = _Output()
        try:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, env=_ENV.copy(), shell=False)
            reader = threading.Thread(target=output.drain, args=(process.stdout,), daemon=True)
            reader.start()
            started = time.monotonic()
            while process.poll() is None:
                if cancel_event is not None and cancel_event.is_set():
                    error_code = "CANCELLED"
                    break
                if time.monotonic() - started >= self.timeout:
                    error_code = "TIMEOUT"
                    break
                if cancel_event is not None:
                    cancel_event.wait(0.025)
                else:
                    time.sleep(0.025)
            if error_code:
                self._remove(name)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            result["exitCode"] = process.poll()
            reader.join(timeout=2)
            if reader.is_alive() or output.failed:
                error_code = error_code or "OUTPUT_INCOMPLETE"
            result["output"] = output.text().replace(source, "/input")
            result["truncated"] = output.truncated
            if result["exitCode"] in (125, 126, 127):
                error_code = error_code or "SANDBOX_START_FAILED"
                result["output"] = ""
            if workspace.work_hash() != result["workHash"]:
                error_code = "WORKSPACE_CHANGED"
            if error_code:
                result.update(errorCode=error_code, summary={"CANCELLED": "测试已取消。", "TIMEOUT": "测试超时，已请求终止沙箱。",
                              "WORKSPACE_CHANGED": "工作区在测试期间发生变化，需要重新测试。"}.get(error_code, "沙箱未能完成测试。"))
            else:
                result["passed"] = result["exitCode"] == 0
                covers_all = project == "all" or bool(changed_projects) and changed_projects <= {project}
                result["complete"] = result["passed"] and not test_files and covers_all
                result["summary"] = "测试通过。" if result["passed"] else "测试未通过。"
        except (OSError, subprocess.SubprocessError, WorkspaceError):
            result.update(errorCode="SANDBOX_UNAVAILABLE", summary="沙箱暂不可用。", output="", complete=False, passed=False)
            if process is not None:
                self._remove(name)
                try:
                    process.kill()
                    process.wait(timeout=2)
                except (OSError, subprocess.SubprocessError):
                    pass
        finally:
            self._remove(name)
            if reader is not None:
                reader.join(timeout=1)
            if process is not None and process.stdout is not None and (reader is None or not reader.is_alive()):
                process.stdout.close()
        return result
