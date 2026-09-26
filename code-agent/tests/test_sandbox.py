import io
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from broker.sandbox import MAX_OUTPUT_BYTES, SandboxRunner
from broker.workspace import Workspace
from broker.projects import CHECK_PROTOCOL


class FakeProcess:
    def __init__(self, output=b"tests passed\n", returncode=0):
        self.stdout = io.BytesIO(output)
        self.returncode = returncode
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired("fixture-docker", timeout)
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9


class SandboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kook-sandbox-test-")
        root = Path(self.temp.name)
        self.work, self.baseline = root / "work", root / "baseline"
        self.work.mkdir()
        self.baseline.mkdir()
        for directory in (self.work, self.baseline):
            (directory / "ai-bot/test").mkdir(parents=True)
            (directory / "ai-bot/test/example.test.js").write_text("// fixture test\n", encoding="utf-8")
            (directory / "ai-bot/package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        self.workspace = Workspace(self.work, self.baseline)
        self.runner = SandboxRunner(timeout=0.01)

    def tearDown(self):
        self.temp.cleanup()

    def test_all_checks_cover_seven_projects_and_propagate_menu_and_ops_failures(self):
        for project in ('quota-dashboard', 'music-bot', 'code-agent', 'bridge-bot', 'ops-center', 'menu-bot'):
            for directory in (self.work, self.baseline):
                (directory / project).mkdir(exist_ok=True)
        self.workspace.write_file('ops-center/agent/test_added.py', 'raise RuntimeError("fixture failure")\n')
        self.workspace.write_file('bridge-bot/test/added.test.js', 'throw new Error("fixture failure");\n')
        self.workspace.write_file('menu-bot/test/added.test.js', 'throw new Error("fixture failure");\n')
        result, popen, _ = self.run_mocked()
        self.assertEqual(set(result.get('coveredProjects', [])),
                         {'ai-bot', 'quota-dashboard', 'music-bot', 'code-agent', 'bridge-bot', 'ops-center', 'menu-bot'})
        self.assertEqual(set(self.workspace.changed_projects()), {'bridge-bot', 'ops-center', 'menu-bot'})
        entrypoint = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'runtime/run-checks.py'))['main']
        copied = Path(self.temp.name) / 'runtime'
        def mapped_path(value):
            return {'/input': self.work, '/work/repo': copied}.get(value, Path(value))
        argv = popen.call_args.args[0]
        image_args = argv[argv.index('/usr/local/bin/run-checks') + 1:]
        for failed_project, executable in [('menu-bot', 'node'), ('ops-center', '/usr/bin/python3')]:
            invoked = []
            def run(command, **options):
                invoked.append((options['cwd'].name, command))
                fail = options['cwd'].name == failed_project and command[0] == executable
                return subprocess.CompletedProcess(command, 1 if fail else 0)
            with self.subTest(failed_project=failed_project), \
                    patch.dict(entrypoint.__globals__, {'Path': mapped_path}), \
                    patch.object(sys, 'argv', ['run-checks', *image_args]), \
                    patch('os.getuid', return_value=1000, create=True), patch.object(Path, 'symlink_to'), \
                    patch.dict(os.environ), patch('subprocess.run', side_effect=run):
                self.assertEqual(entrypoint(), 1)
            self.assertIn(('bridge-bot', ['node', '--test', '--test-concurrency=1']), invoked)
            self.assertIn(('ops-center', ['node', '--test', '--test-concurrency=1']), invoked)
            self.assertIn(('ops-center', ['/usr/bin/python3', '-m', 'unittest', 'discover', '-s', 'agent', '-p', 'test_*.py', '-v']), invoked)
            self.assertIn(('menu-bot', ['node', '--test', '--test-concurrency=1']), invoked)

    def test_runner_rejects_unknown_protocol_before_copying_or_executing(self):
        entrypoint = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'runtime/run-checks.py'))['main']
        for protocol in ['unsupported-image', 'kook-checks-v2-six-projects']:
            with self.subTest(protocol=protocol), \
                    patch.object(sys, 'argv', ['run-checks', '--protocol=' + protocol, 'all']), \
                    patch('shutil.copytree') as copy, patch('subprocess.run') as run:
                self.assertEqual(entrypoint(), 2)
                copy.assert_not_called()
                run.assert_not_called()

    def run_mocked(self, process=None, **kwargs):
        process = process or FakeProcess()
        with patch("broker.sandbox.subprocess.Popen", return_value=process) as popen, patch("broker.sandbox.subprocess.run") as cleanup:
            result = self.runner.run(self.workspace, **kwargs)
        return result, popen, cleanup

    def test_fixed_docker_security_arguments_and_only_source_readonly_mount(self):
        result, popen, cleanup = self.run_mocked()
        self.assertTrue(result["passed"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["workHash"], self.workspace.work_hash())
        args = popen.call_args.args[0]
        for option, value in (("--network", "none"), ("--cap-drop", "ALL"), ("--security-opt", "no-new-privileges"),
                              ("--pids-limit", "128"), ("--memory", "768m"), ("--memory-swap", "768m"),
                              ("--cpus", "1"), ("--user", "1000:1000")):
            self.assertEqual(args[args.index(option) + 1], value)
        self.assertIn("--read-only", args)
        self.assertEqual(args.count("--mount"), 1)
        self.assertEqual(args[args.index("--mount") + 1], f"type=bind,source={self.work},target=/input,readonly")
        self.assertNotIn("--privileged", args)
        self.assertNotIn("-v", args)
        self.assertNotIn("/var/run/docker.sock", str(args))
        self.assertEqual(args[-4:], ["kook-code-sandbox:1", "/usr/local/bin/run-checks", '--protocol=' + CHECK_PROTOCOL, "all"])
        self.assertFalse(popen.call_args.kwargs["shell"])
        self.assertEqual(set(popen.call_args.kwargs["env"]), {"PATH", "LANG", "LC_ALL", "HOME"})
        name = args[args.index("--name") + 1]
        self.assertRegex(name, r"^kook-code-[a-f0-9]{32}$")
        self.assertEqual(cleanup.call_args.args[0], ["/usr/bin/docker", "rm", "-f", name])

    def test_selected_test_paths_are_project_relative_and_do_not_count_as_full_validation(self):
        result, popen, _ = self.run_mocked(project="ai-bot", test_files=["test/example.test.js"])
        self.assertTrue(result["passed"])
        self.assertFalse(result["complete"])
        self.assertEqual(popen.call_args.args[0][-2:], ["ai-bot", "test/example.test.js"])

    def test_repository_relative_test_paths_are_normalized_and_deduplicated(self):
        result, popen, _ = self.run_mocked(project="ai-bot", test_files=["ai-bot/test/example.test.js", "test/example.test.js"])
        self.assertTrue(result["passed"])
        self.assertFalse(result["complete"])
        self.assertEqual(popen.call_args.args[0][-2:], ["ai-bot", "test/example.test.js"])

    def test_node_glob_names_cannot_produce_evidence_for_a_different_existing_file(self):
        self.workspace.write_file("ai-bot/test/a.test.js", "// would pass if incorrectly selected\n")
        self.workspace.write_file("ai-bot/test/[a].test.js", "throw new Error('this literal file must not be bypassed');\n")
        self.workspace.write_file("ai-bot/test/{a,b}.test.js", "throw new Error('brace expansion must not bypass this file');\n")
        for selected in ["test/[a].test.js", "ai-bot/test/[a].test.js", "test/{a,b}.test.js"]:
            with self.subTest(selected=selected):
                result, popen, cleanup = self.run_mocked(project="ai-bot", test_files=[selected])
                self.assertFalse(result["passed"])
                self.assertFalse(result["complete"])
                self.assertEqual(result["errorCode"], "INVALID_TEST_FILES")
                popen.assert_not_called()
                cleanup.assert_not_called()

    @unittest.skipUnless(shutil.which("node"), "Node is needed for actual full-suite discovery")
    def test_grouped_node_filenames_remain_covered_by_full_project_discovery(self):
        self.workspace.write_file("ai-bot/test/a.test.js", "require('node:test')('plain target', () => {});\n")
        self.workspace.write_file("ai-bot/test/[a].test.js",
                                  "require('node:test')('literal grouped target', () => { throw new Error('fixture failure'); });\n")
        result = subprocess.run([shutil.which("node"), "--test", "--test-concurrency=1"], cwd=self.work / "ai-bot",
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"literal grouped target", result.stdout)

    def test_normalized_paths_are_accepted_by_the_image_entrypoint(self):
        self.workspace.write_file("code-agent/tests/test_new.py", "# fixture\n")
        self.workspace.write_file("code-agent/tests/__init__.py", "")
        self.workspace.write_file("ai-bot/test/中文 sample.test.js", "const test = require('node:test');\ntest('fixture', () => {});\n")
        self.workspace.write_file("code-agent/tests/test_中文 sample.py", "import unittest\nclass Fixture(unittest.TestCase):\n def test_ok(self): self.assertTrue(True)\n")
        entrypoint = runpy.run_path(str(Path(__file__).resolve().parents[1] / "runtime" / "run-checks.py"))["main"]
        for project, selected, expected in [
            ("ai-bot", "ai-bot/test/example.test.js", ["node", "--test", "--test-concurrency=1", "test/example.test.js"]),
            ("code-agent", "code-agent/tests/test_new.py", ["/usr/bin/python3", "-m", "unittest", "tests.test_new"]),
            ("ai-bot", "ai-bot/test/中文 sample.test.js", ["node", "--test", "--test-concurrency=1", "test/中文 sample.test.js"]),
            ("code-agent", "code-agent/tests/test_中文 sample.py", ["/usr/bin/python3", "-m", "unittest", "tests.test_中文 sample"]),
        ]:
            with self.subTest(project=project):
                result, popen, _ = self.run_mocked(project=project, test_files=[selected])
                self.assertTrue(result["passed"])
                argv = popen.call_args.args[0]
                image_args = argv[argv.index("/usr/local/bin/run-checks") + 1:]
                runtime_root = Path(self.temp.name) / ("runtime-" + project)
                def mapped_path(value):
                    return {"/input": self.work, "/work/repo": runtime_root}.get(value, Path(value))
                # Execute the actual entrypoint's validation and command building;
                # only its mount locations, UID and external test process are fixtures.
                with patch.dict(entrypoint.__globals__, {"Path": mapped_path}), \
                        patch.object(sys, "argv", ["run-checks", *image_args]), \
                        patch("os.getuid", return_value=1000, create=True), \
                        patch.object(Path, "symlink_to"), patch.dict(os.environ), \
                        patch("subprocess.run", return_value=subprocess.CompletedProcess(expected, 0)) as command:
                    self.assertEqual(entrypoint(), 0)
                self.assertEqual(command.call_args.args[0], expected)
                self.assertEqual(command.call_args.kwargs["cwd"], runtime_root / project)
                if "中文" in selected:
                    executable = sys.executable if project == "code-agent" else shutil.which("node")
                    if executable:
                        actual = subprocess.run([executable, *expected[1:]], cwd=runtime_root / project,
                                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)
                        self.assertEqual(actual.returncode, 0, actual.stdout.decode("utf-8", errors="replace"))
                        self.assertIn(b"1", actual.stdout)

    @unittest.skipIf(os.name == "nt", "Host MAX_PATH prevents constructing this Linux workspace fixture")
    def test_long_paths_use_workspace_limits_instead_of_the_legacy_runner_limit(self):
        long_name = "test/" + "x" * 230 + ".test.js"
        self.workspace.write_file("ai-bot/" + long_name, "// fixture\n")
        result, popen, _ = self.run_mocked(project="ai-bot", test_files=["ai-bot/" + long_name])
        self.assertTrue(result["passed"])
        self.assertEqual(popen.call_args.args[0][-2:], ["ai-bot", long_name])
        valid = runpy.run_path(str(Path(__file__).resolve().parents[1] / "runtime" / "run-checks.py"))["valid_test_path"]
        self.assertTrue(valid(long_name, "ai-bot"))

    def test_image_entrypoint_rejects_unsafe_paths_before_copying_or_launching(self):
        entrypoint = runpy.run_path(str(Path(__file__).resolve().parents[1] / "runtime" / "run-checks.py"))["main"]
        invalid = [("ai-bot", value) for value in ["../test/a.test.js", "/test/a.test.js", "--eval=evil",
                   "test/../a.test.js", "test//a.test.js", "test/./a.test.js", "test/a\n.test.js",
                   "test\\a.test.js", "test/a?.test.js", "test/*.test.js", "test/[a].test.js", "test/{a,b}.test.js",
                   "test/@(a).test.js", "test/+(a).test.js", "test/!(a).test.js", "test/sub[a]/file.test.js",
                   "src/a.test.js", "test/" + "x" * 256 + ".test.js"]]
        invalid += [("code-agent", "tests/test_multi.part.py"), ("code-agent", "tests/a.part/test_new.py"),
                    ("code-agent", "tests/example.test.js")]
        for project, selected in invalid:
            with self.subTest(selected=selected), patch.object(sys, "argv", ["run-checks", project, selected]), \
                    patch("shutil.copytree") as copy, patch("subprocess.run") as command:
                self.assertEqual(entrypoint(), 2)
                copy.assert_not_called()
                command.assert_not_called()

    def test_full_project_suite_covers_only_its_actual_changed_projects(self):
        self.workspace.write_file("ai-bot/new.js", "const value = 1;\n")
        result, _, _ = self.run_mocked(project="ai-bot")
        self.assertTrue(result["complete"])
        self.workspace.write_file("music-bot/new.js", "const value = 2;\n")
        result, _, _ = self.run_mocked(project="ai-bot")
        self.assertFalse(result["complete"])
        result, _, _ = self.run_mocked(project="all")
        self.assertTrue(result["complete"])

    def test_readonly_job_requires_all_projects_for_complete(self):
        result, _, _ = self.run_mocked(project="ai-bot")
        self.assertTrue(result["passed"])
        self.assertFalse(result["complete"])

    def test_dependency_changes_are_rejected_before_launch(self):
        current = self.workspace.read_file("ai-bot/package.json")
        self.workspace.write_file("ai-bot/package.json", '{"name":"changed"}', current["sha256"])
        result, popen, cleanup = self.run_mocked()
        self.assertEqual(result["errorCode"], "DEPENDENCY_CHANGED")
        self.assertFalse(result["complete"])
        popen.assert_not_called()
        cleanup.assert_not_called()

    def test_python_dependency_files_are_also_rejected(self):
        self.workspace.write_file("code-agent/requirements-dev.txt", "unsafe-package\n")
        result, popen, _ = self.run_mocked()
        self.assertEqual(result["errorCode"], "DEPENDENCY_CHANGED")
        popen.assert_not_called()

    def test_invalid_project_path_and_options_never_reach_docker(self):
        for args in ({"project": "other"}, {"project": "all", "test_files": ["test/example.test.js"]},
                     {"project": "ai-bot", "test_files": ["../outside.test.js"]},
                     {"project": "ai-bot", "test_files": ["--test-reporter=evil"]},
                     {"project": "ai-bot", "test_files": ["music-bot/test/example.test.js"]},
                     {"project": "ai-bot", "test_files": ["ai-bot/../music-bot/test/example.test.js"]},
                     {"project": "ai-bot", "test_files": ["/ai-bot/test/example.test.js"]},
                     {"project": "ai-bot", "test_files": ["ai-bot//test/example.test.js"]},
                     {"project": "ai-bot", "test_files": ["ai-bot/./test/example.test.js"]},
                     {"project": "ai-bot", "test_files": ["ai-bot/--test-reporter=evil"]},
                     {"project": "ai-bot", "test_files": ["test/@(a).test.js"]},
                     {"project": "ai-bot", "test_files": ["test/+(a).test.js"]},
                     {"project": "ai-bot", "test_files": ["test/!(a).test.js"]},
                     {"project": "ai-bot", "test_files": ["test/sub[a]/file.test.js"]},
                     {"project": "code-agent", "test_files": ["tests/test_multi.part.py"]},
                     {"project": "code-agent", "test_files": ["tests/a.part/test_new.py"]},
                     {"project": "code-agent", "test_files": ["ai-bot/test/example.test.js"]},
                     {"project": "ai-bot", "test_files": ["src/server.js"]}):
            with self.subTest(args=args):
                result, popen, _ = self.run_mocked(**args)
                self.assertFalse(result["passed"])
                self.assertIn("errorCode", result)
                popen.assert_not_called()

    def test_code_agent_tests_use_python_test_files(self):
        self.workspace.write_file("code-agent/tests/test_new.py", "# fixture\n")
        result, popen, _ = self.run_mocked(project="code-agent", test_files=["tests/test_new.py"])
        self.assertTrue(result["passed"])
        self.assertEqual(popen.call_args.args[0][-2:], ["code-agent", "tests/test_new.py"])

    def test_output_is_drained_and_bounded_with_both_ends_preserved(self):
        raw = b"HEAD\n" + b"x" * (2 * MAX_OUTPUT_BYTES) + b"\nTAIL"
        process = FakeProcess(raw)
        result, _, _ = self.run_mocked(process)
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["output"].encode("utf-8")), MAX_OUTPUT_BYTES)
        self.assertTrue(result["output"].startswith("HEAD"))
        self.assertTrue(result["output"].endswith("TAIL"))
        self.assertIn("output truncated", result["output"])

    def test_invalid_utf8_output_does_not_expand_past_the_byte_budget(self):
        result, _, _ = self.run_mocked(FakeProcess(b"\xff" * MAX_OUTPUT_BYTES))
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["output"].encode("utf-8")), MAX_OUTPUT_BYTES)

    def test_timeout_removes_only_owned_container_and_kills_cli_if_needed(self):
        process = FakeProcess(returncode=None)
        result, popen, cleanup = self.run_mocked(process)
        self.assertEqual(result["errorCode"], "TIMEOUT")
        self.assertFalse(result["passed"])
        self.assertFalse(result["complete"])
        self.assertTrue(process.killed)
        args = popen.call_args.args[0]
        owned = args[args.index("--name") + 1]
        self.assertGreaterEqual(cleanup.call_count, 1)
        self.assertTrue(all(call.args[0] == ["/usr/bin/docker", "rm", "-f", owned] for call in cleanup.call_args_list))

    def test_cancellation_removes_container_and_cancel_before_start_never_launches(self):
        event = threading.Event()
        process = FakeProcess(returncode=None)
        def spawn(*args, **kwargs):
            event.set()
            return process
        with patch("broker.sandbox.subprocess.Popen", side_effect=spawn), patch("broker.sandbox.subprocess.run") as cleanup:
            result = self.runner.run(self.workspace, cancel_event=event)
            self.assertEqual(result["errorCode"], "CANCELLED")
            self.assertTrue(cleanup.called)
        with patch("broker.sandbox.subprocess.Popen") as popen:
            result = self.runner.run(self.workspace, cancel_event=event)
            self.assertEqual(result["errorCode"], "CANCELLED")
            popen.assert_not_called()

    def test_infrastructure_error_text_and_host_paths_are_not_returned(self):
        with patch("broker.sandbox.subprocess.Popen", side_effect=OSError("private host credential path")), patch("broker.sandbox.subprocess.run"):
            result = self.runner.run(self.workspace)
        self.assertEqual(result["errorCode"], "SANDBOX_UNAVAILABLE")
        self.assertNotIn("private", str(result))
        result, _, _ = self.run_mocked(FakeProcess(b"private daemon error", returncode=125))
        self.assertEqual(result["output"], "")
        self.assertEqual(result["errorCode"], "SANDBOX_START_FAILED")
        result, _, _ = self.run_mocked(FakeProcess(str(self.work).encode() + b"/fixture.js"))
        self.assertNotIn(str(self.work), result["output"])
        self.assertIn("/input/fixture.js", result["output"])

    def test_nonzero_test_exit_is_failure_and_still_removes_container(self):
        result, _, cleanup = self.run_mocked(FakeProcess(b"assertion failed", returncode=1))
        self.assertFalse(result["passed"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["exitCode"], 1)
        self.assertEqual(result["output"], "assertion failed")
        self.assertTrue(cleanup.called)

    def test_workspace_change_during_run_invalidates_the_evidence(self):
        hashes = iter(["a" * 64, "b" * 64])
        with patch.object(self.workspace, "work_hash", side_effect=lambda: next(hashes)):
            result, _, _ = self.run_mocked()
        self.assertEqual(result["errorCode"], "WORKSPACE_CHANGED")
        self.assertFalse(result["passed"])
        self.assertFalse(result["complete"])

    def test_mount_csv_metacharacters_are_rejected(self):
        alternate = Path(self.temp.name) / "work,inject"
        alternate.mkdir()
        workspace = Workspace(alternate, self.baseline)
        with patch("broker.sandbox.subprocess.Popen") as popen:
            result = self.runner.run(workspace)
        self.assertEqual(result["errorCode"], "INVALID_ROOT")
        popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
