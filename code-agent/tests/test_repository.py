import copy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from broker.repository import (RepositoryBackend, RepositoryError, REMOTE, REPOSITORY, MAX_BYTES, _default_runner)
from broker.workspace import Workspace
from broker.server import Broker, BrokerError


GIT = shutil.which("git")


@unittest.skipUnless(GIT, "Git is required for local repository tests")
class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kook-repository-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.seed = self.root / "seed"
        self.remote = self.root / "remote.git"
        self.seed.mkdir()
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
                    "GIT_AUTHOR_NAME": "Fixture", "GIT_COMMITTER_NAME": "Fixture",
                    "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}
        self.git(self.seed, "init", "-b", "main")
        for name, text in {"README.md": "Fixture repository\n", "ai-bot/src/app.js": "export const answer = 1;\n",
                           "ai-bot/src/old.js": "old\n", ".github/workflows/test.yml": "name: Fixture\n",
                           "ai-bot/.env.example": "TOKEN=\n", "ai-bot/.env": "PRIVATE_FIXTURE=1\n",
                           "ai-bot/data/private.json": "private fixture\n", "DEPLOYED.md": "private deployment\n"}.items():
            target = self.seed / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        self.git(self.seed, "add", ".")
        self.git(self.seed, "commit", "-m", "Initial fixture")
        self.git(self.root, "clone", "--bare", str(self.seed), str(self.remote))
        self.key = self.root / "deploy key"
        self.hosts = self.root / "known hosts"
        self.key.write_text("fixture-only-not-a-private-key")
        self.hosts.write_text("fixture-only-hosts")
        self.calls = []
        self.fail_after_push = False
        self.backend = RepositoryBackend(self.root / "backend", self.key, self.hosts, git=GIT, runner=self.run_local)

    def git(self, cwd, *arguments):
        result = subprocess.run([GIT, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", *arguments],
                                cwd=cwd, env=self.env, capture_output=True, check=True)
        return result.stdout

    def run_local(self, argv, **options):
        self.calls.append((list(argv), copy.deepcopy(options)))
        # The production API has no remote override. This trusted test runner
        # substitutes its local bare fixture and permits only this local transport.
        command = [str(self.remote) if argument == REMOTE else argument for argument in argv]
        command[1:1] = ["-c", "protocol.file.allow=always"]
        result = _default_runner(command, **options)
        if "push" in argv and self.fail_after_push:
            self.fail_after_push = False
            raise RepositoryError("GIT_FAILED")
        return result

    def prepare(self):
        job_id = str(uuid.uuid4())
        job_root = self.root / "jobs" / job_id
        meta = self.backend.prepare(job_id, job_root)
        return job_id, job_root, meta, Workspace(job_root / "work", job_root / "baseline")

    @staticmethod
    def modify(workspace):
        (workspace.root / "ai-bot/src/app.js").write_bytes(b"export const answer = 2;\n")

    @staticmethod
    def report(workspace):
        work_hash = workspace.work_hash()
        return {"approved": True, "checksPassed": True, "reviewPassed": True, "workHash": work_hash,
                "checks": [{"name": "Node tests", "passed": True, "complete": True, "workHash": work_hash, "exitCode": 0}],
                "review": {"summary": "Reviewed the change", "findings": []}}

    def test_failed_broker_finalization_rolls_back_the_real_prepared_record(self):
        broker = Broker(self.root / "failed-broker", repository=self.backend, sandbox=object())
        with patch("broker.server._private_json", side_effect=BrokerError("STORAGE")):
            with self.assertRaisesRegex(BrokerError, "STORAGE"):
                broker.dispatch("create_job", None, {})
        self.assertEqual(list(broker.jobs.iterdir()), [])
        self.assertEqual(list((self.backend.root / "prepared").iterdir()), [])
        created = broker.dispatch("create_job", None, {})
        self.assertTrue((broker.jobs / created["jobId"] / "job.json").is_file())

    def test_discard_prepared_rejects_mismatched_or_committed_tasks(self):
        job_id, job_root, _meta, _workspace = self.prepare()
        record = self.backend.root / "prepared" / (job_id + ".json")
        original = record.read_bytes()
        with self.assertRaisesRegex(RepositoryError, "JOB_CONFLICT"):
            self.backend.discard_prepared(job_id, self.root / "wrong-job-root")
        committed = job_root / "job.json"
        committed.write_text("{}")
        with self.assertRaisesRegex(RepositoryError, "INVALID_STATE"):
            self.backend.discard_prepared(job_id, job_root)
        committed.unlink()
        publication = self.backend.root / "published" / (job_id + ".json")
        publication.write_text('{"published":true}')
        with self.assertRaisesRegex(RepositoryError, "INVALID_STATE"):
            self.backend.discard_prepared(job_id, job_root)
        self.assertEqual(record.read_bytes(), original)
        publication.unlink()
        self.backend.discard_prepared(job_id, job_root)
        self.assertFalse(record.exists())
        self.assertTrue((job_root / "work").is_dir())
        self.backend.discard_prepared(job_id, job_root)

    def test_prepare_uses_fixed_main_and_exports_only_safe_regular_files(self):
        job_id, job_root, meta, workspace = self.prepare()
        self.assertEqual(meta["repository"], REPOSITORY)
        self.assertEqual(meta["baseSha"], self.git(self.remote, "rev-parse", "main").decode().strip())
        self.assertEqual(meta["branch"], "kook-agent/task-" + job_id)
        for directory in ("baseline", "work"):
            self.assertTrue((job_root / directory / "ai-bot/.env.example").is_file())
            self.assertTrue((job_root / directory / ".github/workflows/test.yml").is_file())
            if os.name != "nt":
                self.assertEqual((job_root / directory).stat().st_mode & 0o777, 0o755)
                self.assertEqual((job_root / directory / "ai-bot/src/app.js").stat().st_mode & 0o777, 0o644)
            for excluded in (".git", "ai-bot/.env", "ai-bot/data/private.json", "DEPLOYED.md"):
                self.assertFalse((job_root / directory / excluded).exists())
        calls = len(self.calls)
        self.assertEqual(self.backend.prepare(job_id, job_root), meta)
        self.assertEqual(len(self.calls), calls)
        fetch = next(command for command, _ in self.calls if "fetch" in command)
        self.assertIn(REMOTE, fetch)
        self.assertIn("+refs/heads/main:refs/heads/source-main", fetch)
        for command, options in self.calls:
            self.assertIn("core.hooksPath=/dev/null", command)
            self.assertIn("core.fsmonitor=false", command)
            self.assertEqual(options["env"]["GIT_CONFIG_NOSYSTEM"], "1")
            self.assertEqual(options["env"]["GIT_CONFIG_GLOBAL"], os.devnull)
            self.assertNotIn("SSH_AUTH_SOCK", options["env"])
            self.assertNotIn("GITHUB_TOKEN", options["env"])
            self.assertIn("StrictHostKeyChecking=yes", options["env"]["GIT_SSH_COMMAND"])
            self.assertIn("-F /dev/null", options["env"]["GIT_SSH_COMMAND"])
        self.assertEqual(workspace.get_diff()["files"], [])

    def test_publish_copies_only_reviewed_changes_and_trusted_report_then_is_idempotent(self):
        job_id, job_root, meta, workspace = self.prepare()
        main = meta["baseSha"]
        self.modify(workspace)
        (workspace.root / "ai-bot/src/new.js").write_bytes(b"export const extra = true;\n")
        (workspace.root / "ai-bot/src/old.js").unlink()
        report = self.report(workspace)
        result = self.backend.publish(job_id, job_root, meta, workspace, report)
        self.assertTrue(result["published"])
        self.assertEqual(result["branch"], meta["branch"])
        self.assertEqual(self.git(self.remote, "rev-parse", "main").decode().strip(), main)
        self.assertEqual(self.git(self.remote, "rev-parse", meta["branch"]).decode().strip(), result["commit"])
        changed = set(self.git(self.remote, "diff-tree", "--no-commit-id", "--name-only", "-r", result["commit"]).decode().splitlines())
        report_root = f".kook-agent/reports/{job_id}"
        self.assertEqual(changed, {"ai-bot/src/app.js", "ai-bot/src/new.js", "ai-bot/src/old.js",
                                   report_root + "/report.md", report_root + "/report.json"})
        self.assertEqual(self.git(self.remote, "show", result["commit"] + ":ai-bot/src/app.js"), b"export const answer = 2;\n")
        saved = json.loads(self.git(self.remote, "show", result["commit"] + ":" + report_root + "/report.json"))
        self.assertEqual(saved["workHash"], workspace.work_hash())
        self.assertEqual(saved["jobId"], job_id)
        self.assertFalse((workspace.root / ".kook-agent").exists())
        self.assertFalse((workspace.root / ".git").exists())
        pushes = [command for command, _ in self.calls if "push" in command]
        self.assertEqual(len(pushes), 1)
        self.assertEqual(pushes[0][-1], result["commit"] + ":refs/heads/" + meta["branch"])
        self.assertNotIn("--force", pushes[0])
        self.assertEqual(self.backend.publish(job_id, job_root, meta, workspace, report), result)
        self.assertEqual(len([command for command, _ in self.calls if "push" in command]), 1)

    def test_archived_reports_do_not_consume_workspace_archive_budget(self):
        archived_path = f".kook-agent/reports/{uuid.uuid4()}/report.md"
        archived = b"Historical review evidence\n" * 8192
        target = self.seed / archived_path
        target.parent.mkdir(parents=True)
        target.write_bytes(archived)
        self.git(self.seed, "add", ".kook-agent")
        self.git(self.seed, "commit", "-m", "Large archived report")
        self.git(self.seed, "push", str(self.remote), "main")
        # The real Git archive would exceed this budget if it included history.
        self.assertGreater(len(archived), 32768)
        with patch("broker.repository.MAX_ARCHIVE", 32768):
            job_id, job_root, meta, workspace = self.prepare()
        self.assertFalse((workspace.root / ".kook-agent").exists())
        self.assertEqual((workspace.root / "ai-bot/src/app.js").read_bytes(),
                         self.git(self.remote, "show", meta["baseSha"] + ":ai-bot/src/app.js"))
        self.modify(workspace)
        result = self.backend.publish(job_id, job_root, meta, workspace, self.report(workspace))
        self.assertEqual(self.git(self.remote, "show", result["commit"] + ":" + archived_path), archived)

    def test_later_task_preserves_previous_task_reports_and_legacy_reports_in_published_tree(self):
        legacy = {".kook-agent/report.json": b'{"legacy":true}\n',
                  ".kook-agent/report.md": b"Original legacy report\n"}
        for name, content in legacy.items():
            target = self.seed / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        self.git(self.seed, "add", ".kook-agent")
        self.git(self.seed, "commit", "-m", "Existing legacy report")
        self.git(self.seed, "push", str(self.remote), "main")

        first_id, first_root, first_meta, first_workspace = self.prepare()
        self.modify(first_workspace)
        first = self.backend.publish(first_id, first_root, first_meta, first_workspace, self.report(first_workspace))
        first_paths = [f".kook-agent/reports/{first_id}/report.{extension}" for extension in ("json", "md")]
        retained = {**legacy, **{name: self.git(self.remote, "show", first["commit"] + ":" + name) for name in first_paths}}
        # Advance only the local fixture main to model the first task being merged.
        self.git(self.remote, "update-ref", "refs/heads/main", first["commit"])

        second_id, second_root, second_meta, second_workspace = self.prepare()
        self.assertEqual(second_meta["baseSha"], first["commit"])
        self.assertFalse((second_workspace.root / ".kook-agent").exists())
        (second_workspace.root / "ai-bot/src/app.js").write_bytes(b"export const answer = 3;\n")
        second = self.backend.publish(second_id, second_root, second_meta, second_workspace, self.report(second_workspace))
        second_paths = [f".kook-agent/reports/{second_id}/report.{extension}" for extension in ("json", "md")]
        tree = set(self.git(self.remote, "ls-tree", "-r", "--name-only", second["commit"]).decode().splitlines())
        self.assertEqual({name for name in tree if name.startswith(".kook-agent/")}, set(retained) | set(second_paths))
        for name, content in retained.items():
            self.assertEqual(self.git(self.remote, "show", second["commit"] + ":" + name), content)
        for job_id, workspace, report_paths in ((first_id, first_workspace, first_paths),
                                               (second_id, second_workspace, second_paths)):
            saved = json.loads(self.git(self.remote, "show", second["commit"] + ":" + report_paths[0]))
            self.assertEqual(saved["jobId"], job_id)
            self.assertEqual(saved["workHash"], workspace.work_hash())
        changed = set(self.git(self.remote, "diff-tree", "--no-commit-id", "--name-only", "-r", second["commit"]).decode().splitlines())
        self.assertEqual(changed, {"ai-bot/src/app.js", *second_paths})

    def test_stale_hash_approval_and_failed_or_incomplete_checks_block_publication(self):
        job_id, job_root, meta, workspace = self.prepare()
        self.modify(workspace)
        original = self.report(workspace)
        cases = []
        for field in ("approved", "checksPassed", "reviewPassed"):
            report = copy.deepcopy(original)
            report[field] = False
            cases.append(report)
        for patch in ({"passed": False}, {"complete": False}, {"workHash": "0" * 64}, {"exitCode": 1}):
            report = copy.deepcopy(original)
            report["checks"][0].update(patch)
            cases.append(report)
        for patch in ({"checks": []}, {"workHash": "0" * 64}):
            cases.append({**original, **patch})
        for report in cases:
            with self.assertRaises(RepositoryError):
                self.backend.publish(job_id, job_root, meta, workspace, report)
        (workspace.root / "ai-bot/src/app.js").write_bytes(b"export const answer = 3;\n")
        with self.assertRaisesRegex(RepositoryError, "STALE_REPORT"):
            self.backend.publish(job_id, job_root, meta, workspace, original)
        self.assertFalse(any("push" in command for command, _ in self.calls))

    def test_workflow_changes_and_meta_remote_or_branch_overrides_are_rejected(self):
        job_id, job_root, meta, workspace = self.prepare()
        self.modify(workspace)
        for tampered in ({**meta, "repository": "attacker/elsewhere"}, {**meta, "branch": "main"}, {**meta, "baseSha": "0" * 40}):
            with self.assertRaisesRegex(RepositoryError, "INVALID_PREPARED_STATE"):
                self.backend.publish(job_id, job_root, tampered, workspace, self.report(workspace))
        (workspace.root / ".github/workflows/test.yml").write_bytes(b"untrusted workflow\n")
        with self.assertRaisesRegex(RepositoryError, "PROTECTED_PATH"):
            self.backend.publish(job_id, job_root, meta, workspace, self.report(workspace))
        with self.assertRaisesRegex(RepositoryError, "INVALID_JOB"):
            self.backend.prepare("../escape", self.root / "escape")
        self.assertFalse(any("push" in command for command, _ in self.calls))

    def test_hardlinked_changed_file_and_tampered_baseline_are_rejected(self):
        job_id, job_root, meta, workspace = self.prepare()
        original = workspace.root / "ai-bot/src/app.js"
        outside = self.root / "outside.txt"
        outside.write_bytes(b"untrusted outside\n")
        original.unlink()
        os.link(outside, original)
        with self.assertRaisesRegex(RepositoryError, "UNSAFE_FILE"):
            self.backend.publish(job_id, job_root, meta, workspace, self.report(workspace))
        original.unlink()
        original.write_bytes(b"new\n")
        (workspace.baseline_root / "ai-bot/src/app.js").write_bytes(b"tampered baseline\n")
        with self.assertRaisesRegex(RepositoryError, "STALE_DIFF"):
            self.backend.publish(job_id, job_root, meta, workspace, self.report(workspace))

    def test_archive_hidden_tracked_file_cannot_be_overwritten_as_a_new_file(self):
        (self.seed / ".gitattributes").write_bytes(b"ai-bot/src/hidden.js export-ignore\n")
        (self.seed / "ai-bot/src/hidden.js").write_bytes(b"hidden original content\n")
        self.git(self.seed, "add", ".")
        self.git(self.seed, "commit", "-m", "Hidden tracked fixture")
        self.git(self.seed, "push", str(self.remote), "main")
        job_id, job_root, meta, workspace = self.prepare()
        self.assertFalse((workspace.root / "ai-bot/src/hidden.js").exists())
        (workspace.root / "ai-bot/src/hidden.js").write_bytes(b"unreviewed overwrite\n")
        with self.assertRaisesRegex(RepositoryError, "STALE_DIFF"):
            self.backend.publish(job_id, job_root, meta, workspace, self.report(workspace))

    def test_report_prose_is_bounded_redacted_and_escaped_not_executed_or_loaded(self):
        job_id, job_root, meta, workspace = self.prepare()
        self.modify(workspace)
        report = self.report(workspace)
        report["privateToken"] = "should-not-be-retained"
        report["review"] = {"summary": '![remote](https://evil.invalid/img) <img src="https://evil.invalid"> sk-privatefixture1234567890',
                            "findings": [{"severity": "high", "path": "ai-bot/src/app.js", "line": 1,
                                          "description": "`code`\n# injected heading", "solution": "$(touch private-file); [link](https://evil.invalid)"}]}
        result = self.backend.publish(job_id, job_root, meta, workspace, report)
        report_root = f".kook-agent/reports/{job_id}"
        markdown = self.git(self.remote, "show", result["commit"] + ":" + report_root + "/report.md").decode()
        metadata = self.git(self.remote, "show", result["commit"] + ":" + report_root + "/report.json").decode()
        self.assertNotIn("![remote]", markdown)
        self.assertNotIn("<img", markdown)
        self.assertNotIn("\n# injected", markdown)
        self.assertNotIn("[link](", markdown)
        self.assertNotIn("sk-privatefixture", markdown + metadata)
        self.assertNotIn("should-not-be-retained", metadata)
        self.assertFalse((self.root / "private-file").exists())

    def test_large_unicode_review_has_bounded_markdown_and_full_json_evidence(self):
        job_id, job_root, meta, workspace = self.prepare()
        self.modify(workspace)
        report = self.report(workspace)
        report["review"] = {"summary": "🦜" * 4000, "findings": [
            {"severity": "P2", "path": "ai-bot/src/app.js", "line": number + 1,
             "description": ("😀![x](https://invalid.example/)" * 100)[:1600],
             "solution": ("😀[]<>`#*!\\" * 200)[:1600]} for number in range(30)]}
        result = self.backend.publish(job_id, job_root, meta, workspace, report)
        report_root = f".kook-agent/reports/{job_id}"
        markdown = self.git(self.remote, "show", result["commit"] + ":" + report_root + "/report.md").decode("utf-8")
        metadata = json.loads(self.git(self.remote, "show", result["commit"] + ":" + report_root + "/report.json"))
        self.assertLessEqual(len(markdown.encode("utf-16-le")) // 2, 28000)
        self.assertIn("完整复核记录见 " + report_root + "/report.json", markdown)
        self.assertNotIn("![x]", markdown)
        self.assertEqual(len(metadata["review"]["findings"]), 30)
        self.assertEqual(metadata["review"]["summary"], "🦜" * 4000)
        self.assertEqual(metadata["workHash"], workspace.work_hash())
        self.assertEqual(self.git(self.remote, "rev-parse", meta["branch"]).decode().strip(), result["commit"])

    def test_ambiguous_successful_push_is_confirmed_without_a_second_push(self):
        job_id, job_root, meta, workspace = self.prepare()
        self.modify(workspace)
        report = self.report(workspace)
        self.fail_after_push = True
        with self.assertRaisesRegex(RepositoryError, "GIT_FAILED"):
            self.backend.publish(job_id, job_root, meta, workspace, report)
        result = self.backend.publish(job_id, job_root, meta, workspace, report)
        self.assertTrue(result["published"])
        self.assertEqual(len([command for command, _ in self.calls if "push" in command]), 1)

    def test_existing_remote_branch_is_never_overwritten_and_pr_lookup_uses_exact_head(self):
        job_id, job_root, meta, workspace = self.prepare()
        self.modify(workspace)
        self.git(self.remote, "update-ref", "refs/heads/" + meta["branch"], meta["baseSha"])
        with self.assertRaisesRegex(RepositoryError, "BRANCH_EXISTS"):
            self.backend.publish(job_id, job_root, meta, workspace, self.report(workspace))
        self.git(self.remote, "update-ref", "refs/pull/42/head", meta["baseSha"])
        self.git(self.remote, "update-ref", "refs/pull/10/merge", meta["baseSha"])
        self.assertEqual(self.backend.lookup_pr(meta["baseSha"]), "https://github.com/chixiaotao-Exm/Kook-Bot/pull/42")
        self.assertIsNone(self.backend.lookup_pr("0" * 40))
        command, options = self.calls[-1]
        self.assertEqual(command[-3:], ["ls-remote", REMOTE, "refs/pull/*/head"])
        self.assertEqual(options["timeout"], 20)
        self.assertEqual(options["max_output_bytes"], 2 * 1024 * 1024)

    def test_git_failures_do_not_expose_upstream_error_or_key_text(self):
        def failed(*_args, **_kwargs):
            raise RuntimeError("private-credential-and-host")
        backend = RepositoryBackend(self.root / "failed-backend", self.key, self.hosts, git=GIT, runner=failed)
        with self.assertRaisesRegex(RepositoryError, "GIT_FAILED") as error:
            backend.prepare(str(uuid.uuid4()), self.root / "failed-job")
        self.assertNotIn("private-credential", str(error.exception))


class ArchiveBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kook-archive-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def prepare_archive(self, entries):
        target = io.BytesIO()
        with tarfile.open(fileobj=target, mode="w") as archive:
            for entry, data in entries:
                archive.addfile(entry, io.BytesIO(data) if data is not None else None)
        def runner(argv, **_options):
            output = target.getvalue() if "archive" in argv else b"a" * 40 + b"\n" if "rev-parse" in argv else b""
            return subprocess.CompletedProcess(argv, 0, output, b"")
        backend = RepositoryBackend(self.root / uuid.uuid4().hex, self.root / "fake-key", self.root / "fake-hosts",
                                    git=os.path.abspath(GIT or sys.executable), runner=runner)
        return backend.prepare(str(uuid.uuid4()), self.root / uuid.uuid4().hex)

    def test_traversal_symlinks_hardlinks_and_duplicate_paths_never_extract(self):
        for name in ("../escape", "/absolute", "ai-bot/../../escape", "ai-bot\\escape"):
            entry = tarfile.TarInfo(name)
            entry.size = 1
            with self.assertRaises(RepositoryError):
                self.prepare_archive([(entry, b"x")])
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            entry = tarfile.TarInfo("ai-bot/src/link.js")
            entry.type = kind
            entry.linkname = "../../outside"
            with self.assertRaisesRegex(RepositoryError, "UNSAFE_ARCHIVE"):
                self.prepare_archive([(entry, None)])
        first = tarfile.TarInfo("README.md")
        first.size = 1
        with self.assertRaisesRegex(RepositoryError, "UNSAFE_ARCHIVE"):
            self.prepare_archive([(first, b"x"), (first, b"x")])

    def test_snapshot_file_count_and_size_are_bounded(self):
        entries = []
        for number in range(1001):
            entry = tarfile.TarInfo(f"ai-bot/src/file-{number}.js")
            entry.size = 1
            entries.append((entry, b"x"))
        with self.assertRaisesRegex(RepositoryError, "REPOSITORY_LIMIT"):
            self.prepare_archive(entries)
        entry = tarfile.TarInfo("large.txt")
        entry.size = MAX_BYTES + 1
        with self.assertRaisesRegex(RepositoryError, "REPOSITORY_LIMIT"):
            self.prepare_archive([(entry, b"x" * entry.size)])


if __name__ == "__main__":
    unittest.main()
