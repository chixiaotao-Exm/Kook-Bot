import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch

from broker.server import Broker, BrokerError, MAX_REQUEST, UnixRpcServer, decode_request, peer_allowed
from broker.repository import REPOSITORY
from broker.workspace import Workspace


class FakeRepository:
    def __init__(self):
        self.prepared = []
        self.published = []
        self.lookups = []
        self.pr = None

    def prepare(self, job_id, root):
        self.prepared.append(job_id)
        for name in ("work", "baseline"):
            (root / name / "ai-bot").mkdir(parents=True)
            (root / name / "ai-bot/source.js").write_text("const value = 1;\n", encoding="utf-8")
            (root / name / ".github").mkdir()
            (root / name / ".github/check.yml").write_text("name: check\n", encoding="utf-8")
        return {"repository": REPOSITORY, "baseSha": "a" * 40, "branch": "kook-agent/task-" + job_id}

    def publish(self, job_id, root, meta, workspace, report):
        self.published.append({"jobId": job_id, "meta": meta, "report": report})
        return {"published": True, "repository": REPOSITORY, "branch": meta["branch"], "commit": "b" * 40,
                "compareUrl": "https://github.com/" + REPOSITORY + "/compare/main..." + meta["branch"]}

    def lookup_pr(self, commit):
        self.lookups.append(commit)
        return self.pr


class FakeSandbox:
    def __init__(self):
        self.calls = []
        self.output = "passed\n"
        self.block = False
        self.entered = threading.Event()
        self.active = 0
        self.max_active = 0
        self.release = threading.Event()

    def run(self, workspace, project="all", test_files=None, cancel_event=None):
        self.calls.append({"project": project, "test_files": test_files, "event": cancel_event})
        self.active += 1
        self.max_active = max(self.active, self.max_active)
        self.entered.set()
        try:
            if self.block:
                while not self.release.is_set() and not cancel_event.is_set():
                    cancel_event.wait(0.01)
            cancelled = cancel_event.is_set()
            return {"passed": not cancelled, "complete": not cancelled and not test_files,
                    "workHash": workspace.work_hash(), "exitCode": 0 if not cancelled else -9,
                    "summary": "测试通过。" if not cancelled else "测试已取消。", "output": self.output,
                    "truncated": False, "project": project, **({"errorCode": "CANCELLED"} if cancelled else {})}
        finally:
            self.active -= 1


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kook-broker-test-")
        self.repository, self.sandbox = FakeRepository(), FakeSandbox()
        self.broker = Broker(Path(self.temp.name) / "private", repository=self.repository, sandbox=self.sandbox)

    def tearDown(self):
        self.temp.cleanup()

    def create(self):
        return self.broker.dispatch("create_job", None, {})

    def change(self, job_id):
        original = self.broker.dispatch("read_file", job_id, {"path": "ai-bot/source.js"})
        return self.broker.dispatch("write_file", job_id, {"path": "ai-bot/source.js", "content": "const value = 2;\n",
                                                         "expectedSha256": original["sha256"]})

    def report(self, job_id):
        current = self.broker.dispatch("get_diff", job_id, {})
        return {"approved": True, "reviewPassed": True, "checksPassed": True, "workHash": current["workHash"],
                "review": {"summary": "Reviewed actual diff", "findings": []}, "checks": [{"forged": True}]}

    def error(self, code, operation, job_id=None, args=None):
        with self.assertRaises(BrokerError) as caught:
            self.broker.dispatch(operation, job_id, {} if args is None else args)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)
        self.assertNotIn(self.temp.name, str(caught.exception))

    def test_create_is_private_bounded_and_returns_only_public_metadata(self):
        created = self.create()
        self.assertEqual(set(created), {"jobId", "baseSha", "repository", "branch"})
        self.assertEqual(str(uuid.UUID(created["jobId"])), created["jobId"])
        self.assertNotIn(self.temp.name, json.dumps(created))
        self.assertTrue((self.broker.jobs / created["jobId"] / "job.json").is_file())
        self.assertTrue(self.broker.dispatch("workspace_info", created["jobId"], {})["workHash"])
        limited = Broker(Path(self.temp.name) / "limited", repository=FakeRepository(), sandbox=self.sandbox, max_jobs=1)
        limited.dispatch("create_job", None, {})
        with self.assertRaises(BrokerError) as caught:
            limited.dispatch("create_job", None, {})
        self.assertEqual(caught.exception.code, "CAPACITY")

    def test_job_and_operation_arguments_are_exact_and_cannot_escape(self):
        job = self.create()["jobId"]
        self.error("INVALID_REQUEST", "exec", job, {"command": "rm anything"})
        self.error("INVALID_ARGUMENTS", "list_files", job, {"path": None, "command": "private"})
        self.error("INVALID_ARGUMENTS", "list_files", job, {"path": False})
        self.error("INVALID_ARGUMENTS", "write_file", job, {"path": "new.js", "content": "x"})
        self.error("INVALID_JOB", "create_job", job)
        self.error("INVALID_JOB", "get_diff", "../escape")
        self.error("INVALID_JOB", "get_diff", job.upper())
        self.error("JOB_NOT_FOUND", "get_diff", str(uuid.uuid4()))
        self.error("INVALID_PATH", "read_file", job, {"path": "../job.json"})

    def test_camel_case_file_tools_and_protected_paths(self):
        job = self.create()["jobId"]
        source = self.broker.dispatch("read_file", job, {"path": "ai-bot/source.js", "startLine": 1, "maxLines": 1})
        self.broker.dispatch("replace_text", job, {"path": "ai-bot/source.js", "oldText": "value = 1", "newText": "value = 2",
                                                   "expectedSha256": source["sha256"]})
        found = self.broker.dispatch("search_code", job, {"query": "value = 2", "path": "ai-bot", "maxResults": 1})
        self.assertEqual(len(found["matches"]), 1)
        self.error("PROTECTED_PATH", "write_file", job, {"path": ".github/check.yml", "content": "replace", "expectedSha256": None})
        self.error("PROTECTED_PATH", "read_file", job, {"path": ".env"})
        self.error("PROTECTED_PATH", "write_file", job, {"path": ".kook-agent/report.json", "content": "{}", "expectedSha256": None})
        self.assertEqual(self.broker.dispatch("job_status", job, {})["status"], "modified")

    def test_client_forged_checks_cannot_publish_without_broker_evidence(self):
        job = self.create()["jobId"]
        self.change(job)
        report = self.report(job)
        report["checks"] = [{"passed": True, "complete": True, "workHash": report["workHash"], "exitCode": 0}]
        self.error("CHECKS_REQUIRED", "publish", job, {"report": report})
        self.assertEqual(self.repository.published, [])

    def test_successful_publish_replaces_caller_checks_with_trusted_exact_hash_record(self):
        job = self.create()["jobId"]
        self.change(job)
        checked = self.broker.dispatch("run_checks", job, {"project": None, "testFiles": []})
        self.assertTrue(checked["passed"])
        self.assertEqual(checked["checks"], [{"name": "all fixed checks", "passed": True, "complete": True,
                                             "workHash": checked["workHash"], "exitCode": 0, "summary": "测试通过。"}])
        published = self.broker.dispatch("publish", job, {"report": self.report(job)})
        self.assertTrue(published["published"])
        secured = self.repository.published[0]["report"]
        self.assertEqual(secured["checks"][0]["workHash"], checked["workHash"])
        self.assertTrue(secured["checks"][0]["complete"])
        self.assertNotIn("forged", json.dumps(secured))
        self.error("JOB_PUBLISHED", "write_file", job, {"path": "new.js", "content": "x", "expectedSha256": None})

    def test_missing_review_or_stale_hash_blocks_publish(self):
        job = self.create()["jobId"]
        self.change(job)
        self.broker.dispatch("run_checks", job, {})
        report = self.report(job)
        self.error("REVIEW_REQUIRED", "publish", job, {"report": {**report, "reviewPassed": False}})
        self.error("REVIEW_REQUIRED", "publish", job, {"report": {**report, "approved": 1}})
        self.broker.dispatch("write_file", job, {"path": "ai-bot/new.js", "content": "new", "expectedSha256": None})
        self.error("STALE_HASH", "publish", job, {"report": report})
        self.error("CHECKS_REQUIRED", "publish", job, {"report": self.report(job)})
        self.assertFalse(self.repository.published)

    def test_partial_checks_never_authorize_publish_and_failed_latest_check_invalidates_pass(self):
        job = self.create()["jobId"]
        self.change(job)
        self.broker.dispatch("run_checks", job, {"project": "ai-bot", "testFiles": ["test/one.test.js"]})
        self.error("CHECKS_REQUIRED", "publish", job, {"report": self.report(job)})
        self.broker.dispatch("run_checks", job, {})
        with patch.object(self.sandbox, "run", return_value={"passed": False, "complete": False, "workHash": self.report(job)["workHash"], "exitCode": 1}):
            self.broker.dispatch("run_checks", job, {})
        self.error("CHECKS_REQUIRED", "publish", job, {"report": self.report(job)})

    def test_checks_output_is_small_in_rpc_but_full_bounded_evidence_stays_private(self):
        job = self.create()["jobId"]
        self.sandbox.output = "x" * 60_000
        checked = self.broker.dispatch("run_checks", job, {})
        self.assertEqual(len(checked["output"]), 16_000)
        self.assertTrue(checked["truncated"])
        state = json.loads((self.broker.jobs / job / "job.json").read_text(encoding="utf-8"))
        self.assertEqual(len(state["checks"][0]["output"]), 60_000)
        for _ in range(21):
            self.broker.dispatch("run_checks", job, {})
        state = json.loads((self.broker.jobs / job / "job.json").read_text(encoding="utf-8"))
        self.assertEqual(len(state["checks"]), 20)

    def test_cancel_does_not_wait_for_the_job_lock_and_always_clears_registration(self):
        job = self.create()["jobId"]
        self.sandbox.block = True
        output = []
        worker = threading.Thread(target=lambda: output.append(self.broker.dispatch("run_checks", job, {})))
        worker.start()
        self.assertTrue(self.sandbox.entered.wait(1))
        began = time.monotonic()
        cancelled = self.broker.dispatch("cancel_operation", job, {})
        self.assertTrue(cancelled["cancelled"])
        self.assertLess(time.monotonic() - began, 0.2)
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertFalse(output[0]["passed"])
        self.assertEqual(output[0]["errorCode"], "CANCELLED")
        self.assertFalse(self.broker.dispatch("cancel_operation", job, {})["cancelled"])

    def test_only_one_sandbox_runs_globally_and_a_queued_run_can_be_cancelled(self):
        first, second = self.create()["jobId"], self.create()["jobId"]
        self.sandbox.block = True
        outputs = []
        workers = [threading.Thread(target=lambda job=job: outputs.append(self.broker.dispatch("run_checks", job, {}))) for job in (first, second)]
        workers[0].start()
        self.assertTrue(self.sandbox.entered.wait(1))
        workers[1].start()
        for _ in range(100):
            with self.broker._registry:
                ready = second in self.broker._cancellations
            if ready:
                break
            time.sleep(0.005)
        self.assertTrue(self.broker.dispatch("cancel_operation", second, {})["cancelled"])
        workers[1].join(2)
        self.broker.dispatch("cancel_operation", first, {})
        workers[0].join(2)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(self.sandbox.max_active, 1)
        self.assertEqual(len(self.sandbox.calls), 1)

    def test_job_status_never_looks_up_unpublished_jobs_and_caches_confirmed_pr(self):
        job = self.create()["jobId"]
        self.broker.dispatch("job_status", job, {})
        self.assertEqual(self.repository.lookups, [])
        self.change(job)
        self.broker.dispatch("run_checks", job, {})
        self.broker.dispatch("publish", job, {"report": self.report(job)})
        self.repository.pr = "https://github.com/" + REPOSITORY + "/pull/123"
        first = self.broker.dispatch("job_status", job, {})
        second = self.broker.dispatch("job_status", job, {})
        self.assertEqual(first["prUrl"], self.repository.pr)
        self.assertEqual(second["prUrl"], first["prUrl"])
        self.assertEqual(len(self.repository.lookups), 1)
        self.assertNotIn(self.temp.name, json.dumps(second))

    def test_unexpected_backend_errors_are_sanitized(self):
        with patch.object(self.repository, "prepare", side_effect=RuntimeError("private secret key /root/path")):
            self.error("BROKER_FAILED", "create_job")


class ProtocolTests(unittest.TestCase):
    def test_json_protocol_rejects_duplicate_unknown_and_oversized_requests(self):
        valid = {"operation": "create_job", "jobId": None, "args": {}}
        self.assertEqual(decode_request(json.dumps(valid).encode()), valid)
        invalid = [b'{"operation":"create_job","operation":"exec","jobId":null,"args":{}}',
                   b'{"operation":"create_job","jobId":null,"args":{"x":1,"x":2}}',
                   b'{"operation":"create_job","jobId":null,"args":{},"admin":true}', b"[]", b"NaN", b"\xff"]
        for raw in invalid:
            with self.assertRaises(BrokerError):
                decode_request(raw)
        with self.assertRaises(BrokerError) as caught:
            decode_request(b"x" * (MAX_REQUEST + 1))
        self.assertEqual(caught.exception.code, "REQUEST_LIMIT")

    def test_linux_peer_uid_auth_fails_closed(self):
        class Peer:
            def __init__(self, uid):
                self.uid = uid
            def getsockopt(self, *args):
                return struct.pack("3i", 123, self.uid, 999)
        with patch.object(socket, "SO_PEERCRED", 17, create=True):
            self.assertTrue(peer_allowed(Peer(0), {0, 1234}))
            self.assertTrue(peer_allowed(Peer(1234), {0, 1234}))
            self.assertFalse(peer_allowed(Peer(4321), {0, 1234}))
        class FailedPeer:
            def getsockopt(self, *args):
                raise OSError("private descriptor")
        self.assertFalse(peer_allowed(FailedPeer(), {0, 1234}))

    @unittest.skipUnless(os.name == "posix" and hasattr(socket, "SO_PEERCRED"), "Linux Unix credentials integration")
    def test_real_unix_http_socket_permissions_and_response_contract(self):
        with tempfile.TemporaryDirectory(prefix="kook-rpc-") as directory:
            broker = Broker(Path(directory) / "private", repository=FakeRepository(), sandbox=FakeSandbox())
            socket_path = Path(directory) / "rpc.sock"
            server = UnixRpcServer(socket_path, broker, {os.getuid()})
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.assertEqual(socket_path.stat().st_mode & 0o777, 0o660)
                body = json.dumps({"operation": "create_job", "jobId": None, "args": {}}).encode()
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.connect(str(socket_path))
                    connection.sendall(b"POST /rpc HTTP/1.0\r\nHost: localhost\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
                    chunks = []
                    while chunk := connection.recv(65536):
                        chunks.append(chunk)
                response = json.loads(b"".join(chunks).split(b"\r\n\r\n", 1)[1])
                self.assertTrue(response["ok"])
                self.assertEqual(response["data"]["repository"], REPOSITORY)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(2)


if __name__ == "__main__":
    unittest.main()
