import hashlib
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from broker.workspace import Workspace, WorkspaceError, is_allowed_path, validate_path


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kook-workspace-test-")
        self.base = Path(self.temp.name)
        self.root = self.base / "work"
        self.baseline = self.base / "baseline"
        self.root.mkdir()
        self.baseline.mkdir()
        self.workspace = Workspace(self.root, self.baseline)

    def tearDown(self):
        self.temp.cleanup()

    def put(self, path, content, both=True):
        data = content.encode("utf-8") if isinstance(content, str) else content
        for root in (self.root, self.baseline) if both else (self.root,):
            file = root / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        return hashlib.sha256(data).hexdigest()

    def error(self, code, function, *args, **kwargs):
        with self.assertRaises(WorkspaceError) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)
        self.assertNotIn(str(self.base), str(caught.exception))

    def test_literal_posix_paths_reject_escape_and_windows_aliases(self):
        for path in ("../outside", "/etc/passwd", "C:/Windows/file", "a\\b", "a/../b", "./a", "a//b", "a/",
                     "a\x00b", "file:stream", "a\nb", "CON.txt", "a/NUL", "file.", "file ", "\ud800"):
            with self.subTest(path=repr(path)):
                self.error("INVALID_PATH", validate_path, path)
        self.assertEqual(validate_path("ai-bot/src/中文.js"), "ai-bot/src/中文.js")
        self.error("PATH_DEPTH", validate_path, "/".join(["nested"] * 13 + ["file.py"]))

    def test_secret_paths_are_not_read_listed_searched_or_written(self):
        paths = [".git/config", ".env", ".env.production", "ai-bot/.env", "node_modules/private.js", "data/secrets.json",
                 "release/secret.txt", "output/raw.txt", "DEPLOYED.md", ".kook-agent/report.json", ".npmrc"]
        for path in paths:
            self.put(path, "fixture-private-secret")
            self.error("PROTECTED_PATH", self.workspace.read_file, path)
            self.error("PROTECTED_PATH", self.workspace.write_file, path, "replacement")
        self.assertEqual(self.workspace.list_files()["files"], [])
        self.assertEqual(self.workspace.search_code("fixture-private-secret")["matches"], [])
        self.assertEqual(self.workspace.get_diff()["files"], [])

    def test_env_example_and_github_are_readable_but_workflow_writes_are_denied(self):
        sample_hash = self.put(".env.example", "TOKEN=example\n")
        workflow_hash = self.put(".github/workflows/check.yml", "name: tests\n")
        self.assertIn("TOKEN=example", self.workspace.read_file(".env.example")["content"])
        self.workspace.write_file(".env.example", "TOKEN=another-example\n", sample_hash)
        self.assertIn("name: tests", self.workspace.read_file(".github/workflows/check.yml")["content"])
        self.error("PROTECTED_PATH", self.workspace.write_file, ".github/workflows/check.yml", "replace", workflow_hash)
        self.error("PROTECTED_PATH", self.workspace.replace_text, ".github/workflows/check.yml", "tests", "other", workflow_hash)
        listed = self.workspace.list_files(".github")["files"]
        self.assertFalse(listed[0]["writable"])

    def test_symlink_file_directory_and_broken_link_cannot_be_followed(self):
        outside = self.base / "outside-secret.txt"
        outside.write_text("fixture outside secret", encoding="utf-8")
        cases = [("file-link", outside, False), ("dir-link", self.base, True), ("broken-link", self.base / "missing", False)]
        for name, target, directory in cases:
            link = self.root / name
            try:
                link.symlink_to(target, target_is_directory=directory)
            except OSError:
                self.skipTest("Host does not allow creating symlinks")
            request = name + "/outside-secret.txt" if directory else name
            self.error("SYMLINK", self.workspace.read_file, request)
            self.error("SYMLINK", self.workspace.write_file, request, "replacement")
            self.error("SYMLINK", self.workspace.info)
            link.unlink()
        self.assertEqual(outside.read_text(encoding="utf-8"), "fixture outside secret")

    def test_existing_edits_require_the_exact_current_raw_byte_hash(self):
        digest = self.put("ai-bot/src/example.js", "const value = 1;\r\n")
        self.error("HASH_REQUIRED", self.workspace.write_file, "ai-bot/src/example.js", "new")
        self.error("STALE_HASH", self.workspace.write_file, "ai-bot/src/example.js", "new", "0" * 64)
        result = self.workspace.write_file("ai-bot/src/example.js", "const value = 2;\n", digest)
        self.assertFalse(result["created"])
        self.error("STALE_HASH", self.workspace.write_file, "ai-bot/src/example.js", "old retry", digest)
        self.assertEqual((self.baseline / "ai-bot/src/example.js").read_bytes(), b"const value = 1;\r\n")
        self.assertNotEqual(result["sha256"], digest)

    def test_new_file_requires_null_hash_and_parent_depth_is_bounded(self):
        self.error("STALE_HASH", self.workspace.write_file, "new.py", "print('x')", "0" * 64)
        path = "/".join(["nested"] * 12 + ["file.py"])
        self.assertTrue(self.workspace.write_file(path, "value = 1\n")["created"])
        self.assertEqual((self.root / path).read_text(encoding="utf-8"), "value = 1\n")
        self.error("PATH_DEPTH", self.workspace.write_file, "/".join(["deep"] * 13 + ["file.py"]), "x")
        self.put("regular", "text")
        self.error("NOT_DIRECTORY", self.workspace.write_file, "regular/child.py", "x")

    @unittest.skipIf(os.name == "nt", "POSIX permissions are checked on the Linux deployment host")
    def test_new_files_are_readable_by_nonroot_sandbox_under_restrictive_umask(self):
        old = os.umask(0o077)
        try:
            self.workspace.write_file("code-agent/new/file.py", "value = 1\n")
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE((self.root / "code-agent/new").stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.root / "code-agent/new/file.py").stat().st_mode), 0o644)

    def test_replace_is_unique_literal_and_rejects_overlapping_matches(self):
        digest = self.put("ai-bot/source.js", "literal .* token\n")
        result = self.workspace.replace_text("ai-bot/source.js", ".*", "safe", digest)
        self.assertIn("literal safe token", self.workspace.read_file("ai-bot/source.js")["content"])
        self.error("MATCH_NOT_FOUND", self.workspace.replace_text, "ai-bot/source.js", "absent", "x", result["sha256"])
        overlap = self.put("overlap.txt", "aaa")
        self.error("MATCH_NOT_UNIQUE", self.workspace.replace_text, "overlap.txt", "aa", "b", overlap)
        self.error("INVALID_REPLACEMENT", self.workspace.replace_text, "overlap.txt", "", "b", overlap)

    def test_read_returns_raw_hash_line_numbers_and_bounded_output(self):
        digest = self.put("lines.txt", "\n".join(f"line {n}" for n in range(400)))
        result = self.workspace.read_file("lines.txt", start_line=2, max_lines=2)
        self.assertEqual(result["content"], "2: line 1\n3: line 2")
        self.assertEqual(result["sha256"], digest)
        self.assertTrue(result["truncated"])
        self.put("long.txt", "x" * 40_000)
        self.assertLessEqual(len(self.workspace.read_file("long.txt")["content"]), 16_000)
        self.error("INVALID_LIMIT", self.workspace.read_file, "lines.txt", max_lines=201)
        self.error("INVALID_LIMIT", self.workspace.read_file, "lines.txt", start_line=0)

    def test_search_is_literal_bounded_and_does_not_read_binary_data(self):
        self.put("ai-bot/src/example.js", "literal a.*b\nother axb\na.*b again\n")
        self.put("image.bin", b"\xff\x00a.*b")
        result = self.workspace.search_code("a.*b", max_results=1)
        self.assertEqual(len(result["matches"]), 1)
        self.assertEqual(result["matches"][0]["line"], 1)
        self.assertTrue(result["truncated"])
        self.assertEqual(self.workspace.search_code("axb")["matches"][0]["line"], 2)

    def test_binary_and_oversized_files_are_readonly(self):
        binary = self.put("image.png", b"\x89PNG\x00\xff")
        self.error("NOT_TEXT", self.workspace.read_file, "image.png")
        self.error("NOT_TEXT", self.workspace.write_file, "image.png", "text", binary)
        self.assertFalse(self.workspace.list_files()["files"][0]["readable"])
        self.error("NOT_TEXT", self.workspace.write_file, "new.txt", "text\x00binary")
        self.error("FILE_TOO_LARGE", self.workspace.write_file, "large.txt", "界" * 90_000)
        self.put("large.bin", b"x" * (256 * 1024 + 1))
        self.error("FILE_TOO_LARGE", self.workspace.read_file, "large.bin")

    def test_repository_file_and_byte_budgets_prevent_writes_before_mutation(self):
        self.put("one.txt", "1234")
        self.put("two.txt", "1234")
        with patch("broker.workspace.MAX_FILES", 2):
            self.error("WORKSPACE_LIMIT", self.workspace.write_file, "three.txt", "x")
        with patch("broker.workspace.MAX_BYTES", 8):
            self.error("WORKSPACE_LIMIT", self.workspace.write_file, "three.txt", "x")
        self.assertFalse((self.root / "three.txt").exists())
        limits = self.workspace.info()
        self.assertEqual(limits["maxFiles"], 1000)
        self.assertEqual(limits["maxBytes"], 8 * 1024 * 1024)

    def test_diff_machine_hashes_cover_changes_even_when_display_is_truncated(self):
        before = self.put("ai-bot/a.js", "old\n" * 100)
        self.put("music-bot/deleted.js", "deleted\n")
        (self.root / "music-bot/deleted.js").unlink()
        after = self.workspace.write_file("ai-bot/a.js", "new\n" * 100, before)["sha256"]
        self.workspace.write_file("quota-dashboard/added.js", "added\n")
        result = self.workspace.get_diff(max_chars=30)
        self.assertEqual(len(result["files"]), 3)
        self.assertLessEqual(len(result["diff"]), 30)
        self.assertTrue(result["truncated"])
        modified = next(item for item in result["files"] if item["path"] == "ai-bot/a.js")
        self.assertEqual(modified["beforeSha256"], before)
        self.assertEqual(modified["afterSha256"], after)
        self.assertEqual(modified["status"], "modified")
        self.assertEqual(set(result["changedProjects"]), {"ai-bot", "music-bot", "quota-dashboard"})
        self.assertEqual(result["workHash"], self.workspace.work_hash())

    def test_work_hash_is_content_and_path_based_and_includes_readonly_workflows(self):
        self.put("a.txt", "content")
        self.put(".github/workflows/check.yml", "name: check\n")
        original = self.workspace.work_hash()
        os.utime(self.root / "a.txt", (1_000_000, 1_000_000))
        self.assertEqual(self.workspace.work_hash(), original)
        (self.root / "a.txt").rename(self.root / "b.txt")
        self.assertNotEqual(self.workspace.work_hash(), original)
        self.assertEqual(set(self.workspace.changed_projects()), {"ai-bot", "music-bot", "quota-dashboard", "code-agent", "bridge-bot", "ops-center"})

    def test_binary_diff_never_exposes_binary_bytes(self):
        self.put("asset.bin", b"\xffPRIVATE_BINARY_DATA")
        (self.root / "asset.bin").write_bytes(b"\xfeDIFFERENT_BINARY_DATA")
        result = self.workspace.get_diff()
        self.assertTrue(result["files"][0]["binary"])
        self.assertNotIn("PRIVATE_BINARY_DATA", result["diff"])
        self.assertNotIn("DIFFERENT_BINARY_DATA", result["diff"])

    def test_baseline_must_be_separate_and_errors_expose_no_host_path(self):
        self.error("INVALID_ROOT", Workspace, self.root, self.root)
        child = self.root / "nested-baseline"
        child.mkdir()
        self.error("INVALID_ROOT", Workspace, self.root, child)
        self.error("NOT_FOUND", self.workspace.read_file, "missing.py")


if __name__ == "__main__":
    unittest.main()
