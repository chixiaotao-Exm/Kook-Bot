import io
import json
import os
from pathlib import Path
import subprocess
import signal
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from collector import (Agent, AgentError, CommandLedger, JsonHttp, MAX_BODY, MetricsCollector, NoRedirect,
                       ProbeCollector, ServiceRunner, SYSTEMCTL, absolute_deadline, atomic_json, iso, validate_config)

NOW = 1790244000
TOKEN = "fixture-private-token-" + "a" * 32
SERVICE = {"id": "music", "name": "Music", "unit": "kook-music-bot.service", "expected": "running", "restartAllowed": True}


def config(data_dir):
    return {"serverUrl": "https://ops.example/ops/", "hostId": "music-cn", "token": TOKEN, "intervalSeconds": 30,
            "dataDir": str(data_dir), "services": [dict(SERVICE)], "probes": []}


def command(identifier="command-1", **changes):
    return {"id": identifier, "serviceId": "music", "action": "restart", "expiresAt": iso(NOW + 120), **changes}


class TemporaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kook-ops-agent-test-")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()


class ConfigTests(TemporaryTests):
    def test_valid_config_is_copied_and_preserves_only_fixed_fields(self):
        value = config(self.root)
        value["probes"] = [{"id": "ai", "kind": "ai", "url": "http://127.0.0.1:19000/health"}]
        normalized = validate_config(value)
        value["services"][0]["unit"] = "changed.service"
        self.assertEqual(normalized["services"][0]["unit"], SERVICE["unit"])
        self.assertEqual(normalized["serverUrl"], "https://ops.example/ops/")

    def test_rejects_remote_plain_http_redirect_like_urls_and_command_units(self):
        for change in [{"serverUrl": "http://ops.example/ops/"}, {"serverUrl": "https://x:secret@ops.example/ops/"},
                       {"serverUrl": "https://ops.example/ops/?token=x"}, {"token": "secret\nvalue"}, {"intervalSeconds": True},
                       {"services": [{**SERVICE, "unit": "nginx.service;reboot"}]},
                       {"services": [{**SERVICE, "unit": "../../evil.service"}]},
                       {"services": [{**SERVICE, "unit": "--now.service"}]}, {"services": [SERVICE, SERVICE]},
                       {"probes": [{"id": "external", "kind": "music", "url": "http://remote.example/"}]},
                       {"hostId": 123}]:
            with self.subTest(change=list(change)):
                with self.assertRaises(AgentError):
                    validate_config({**config(self.root), **change})


class MetricsTests(TemporaryTests):
    def metrics(self, cpu):
        self.root.joinpath("stat").write_text(cpu + "\ncpu0 0 0 0 0\n")
        self.root.joinpath("meminfo").write_text("MemTotal: 1000 kB\nMemFree: 20 kB\nMemAvailable: 400 kB\n")
        self.root.joinpath("loadavg").write_text("1.25 0.5 0.1 2/100 999\n")
        self.root.joinpath("uptime").write_text("3600.5 500.2\n")

    def test_cpu_delta_memory_available_statvfs_load_and_uptime(self):
        self.metrics("cpu 10 0 10 80 0 0 0 0 50 0")
        filesystem = Mock(f_blocks=100, f_bfree=40, f_bavail=30)
        collector = MetricsCollector(self.root, statvfs=lambda _: filesystem)
        first = collector.collect()
        self.assertIsNone(first["cpuPercent"])
        self.assertEqual(first["memoryPercent"], 60)
        self.assertEqual(first["diskPercent"], 66.67)
        self.assertEqual(first["load1"], 1.25)
        self.assertEqual(first["uptimeSeconds"], 3600.5)
        self.metrics("cpu 20 0 20 160 0 0 0 0 500 0")
        self.assertEqual(collector.collect()["cpuPercent"], 20, "Guest CPU counters must not be counted twice")
        self.metrics("cpu 1 0 1 8 0 0 0 0")
        self.assertIsNone(collector.collect()["cpuPercent"], "Counter reset is unknown rather than a bogus percentage")

    def test_missing_or_invalid_sources_are_unknown_not_zero(self):
        collector = MetricsCollector(self.root, statvfs=lambda _: (_ for _ in ()).throw(OSError()))
        self.assertTrue(all(value is None for value in collector.collect().values()))
        self.metrics("cpu invalid")
        self.root.joinpath("meminfo").write_text("MemTotal: 100 kB\nMemAvailable: 200 kB\n")
        self.root.joinpath("loadavg").write_text("NaN")
        self.root.joinpath("uptime").write_text("-1")
        self.assertTrue(all(value is None for value in collector.collect().values()))


class ServiceTests(unittest.TestCase):
    def test_exact_status_arguments_never_contain_shell_or_environment_secrets(self):
        run = Mock(return_value=subprocess.CompletedProcess([], 0, "ActiveState=active\nSubState=running\nMainPID=44\nNRestarts=2\n", ""))
        result = ServiceRunner(run).status(SERVICE)
        self.assertEqual(result, {"id": "music", "activeState": "active", "subState": "running", "pid": 44, "restarts": 2, "ok": True})
        self.assertEqual(run.call_args.args[0], [SYSTEMCTL, "show", SERVICE["unit"], "--no-pager", "--property=ActiveState,SubState,MainPID,NRestarts"])
        self.assertFalse(run.call_args.kwargs["shell"])
        self.assertEqual(run.call_args.kwargs["timeout"], 10)
        self.assertNotIn("TOKEN", run.call_args.kwargs["env"])

    def test_expected_stopped_is_not_treated_as_an_outage_or_running_service(self):
        run = Mock(return_value=subprocess.CompletedProcess([], 0, "ActiveState=inactive\nSubState=dead\nMainPID=0\nNRestarts=0\n", ""))
        runner = ServiceRunner(run)
        self.assertTrue(runner.status({**SERVICE, "expected": "stopped"})["ok"])
        self.assertFalse(runner.status(SERVICE)["ok"])

    def test_restart_is_one_fixed_command_and_timeout_is_unknown(self):
        run = Mock(side_effect=[subprocess.CompletedProcess([], 0, "", ""),
                               subprocess.CompletedProcess([], 0, "ActiveState=active\nSubState=running\nMainPID=9\nNRestarts=0\n", "")])
        self.assertEqual(ServiceRunner(run).restart(SERVICE), "succeeded")
        self.assertEqual(run.call_args_list[0].args[0], [SYSTEMCTL, "restart", SERVICE["unit"]])
        failed = ServiceRunner(Mock(side_effect=subprocess.TimeoutExpired("fixture", 10)))
        self.assertEqual(failed.restart(SERVICE), "unknown")
        self.assertEqual(failed.status(SERVICE)["activeState"], "unknown")


class FakeResponse:
    def __init__(self, body=b"{}", headers=None):
        self.body, self.headers, self.closed = body, headers or {}, False
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.closed = True
    def read(self, limit):
        return self.body[:limit]


class HttpTests(unittest.TestCase):
    @unittest.skipUnless(hasattr(signal, "setitimer"), "Linux absolute HTTP deadline uses setitimer")
    def test_absolute_deadline_is_not_an_oserror_that_dns_connect_fallback_can_swallow(self):
        before = signal.getsignal(signal.SIGALRM)
        with self.assertRaises(AgentError):
            with absolute_deadline(0.02):
                try:
                    time.sleep(0.2)
                except OSError:
                    self.fail("A network retry swallowed the absolute deadline")
        self.assertEqual(signal.getsignal(signal.SIGALRM), before)

    def test_report_token_only_enters_authorization_and_reads_are_bounded(self):
        client = JsonHttp(); response = FakeResponse(b'{"commands":[]}')
        client.opener = Mock(); client.opener.open.return_value = response
        self.assertEqual(client.request("https://ops.example/ops/api/agent/report", token=TOKEN, body={"hostId": "fixture"}), {"commands": []})
        request = client.opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
        self.assertNotIn(TOKEN.encode(), request.data)
        self.assertEqual(client.opener.open.call_args.kwargs["timeout"], 10)
        self.assertTrue(response.closed)
        self.assertIsNone(NoRedirect().redirect_request(request, None, 302, "", {}, "https://elsewhere.invalid/"))

    def test_huge_bodies_and_invalid_json_are_rejected_without_a_second_request(self):
        for response in [FakeResponse(headers={"Content-Length": str(MAX_BODY + 1)}), FakeResponse(b"x" * (MAX_BODY + 1)), FakeResponse(b"[]"), FakeResponse(b"not json")]:
            client = JsonHttp(); client.opener = Mock(); client.opener.open.return_value = response
            with self.assertRaises((AgentError, ValueError)):
                client.request("http://127.0.0.1/health")
            self.assertEqual(client.opener.open.call_count, 1)
        client = JsonHttp(); client.opener = Mock()
        with self.assertRaises(AgentError):
            client.request("https://ops.example/ops/api/agent/report", body={"oversized": "x" * MAX_BODY})
        client.opener.open.assert_not_called()

    def test_503_health_can_report_offline_but_redirect_and_report_503_are_failures(self):
        for allowed in [True, False]:
            client = JsonHttp(); client.opener = Mock()
            client.opener.open.side_effect = HTTPError("http://127.0.0.1/health", 503, "fixture", {}, io.BytesIO(b'{"ok":false}'))
            if allowed:
                self.assertEqual(client.request("http://127.0.0.1/health", allow_health_error=True), {"ok": False})
            else:
                with self.assertRaises(AgentError):
                    client.request("http://127.0.0.1/health")


class ProbeTests(unittest.TestCase):
    def test_music_uses_only_guest_cached_routes_and_reuses_cookie_session(self):
        calls = []
        def request(url, **kwargs):
            calls.append((url, kwargs))
            if url.endswith("/api/session"):
                return {"authenticated": True, "actor": {"siteAdmin": False}}
            if url.endswith("/api/bots"):
                return {"bots": [{"id": "default", "name": "美团外卖", "online": True, "status": "ready", "context": {"voiceChannelId": "200"}}]}
            return {"generatedAt": NOW * 1000, "bots": [{"id": "default", "status": "playing", "channelId": "200", "issue": ""}]}
        collector = ProbeCollector(http=Mock(request=request), now=lambda: NOW)
        probe = {"id": "music", "kind": "music", "url": "http://127.0.0.1:8787"}
        result = collector.collect(probe)[0]
        self.assertEqual(result["state"], "online"); self.assertTrue(result["playing"]); self.assertEqual(result["channelName"], "200")
        collector.collect(probe)
        self.assertEqual([url.rsplit("/", 1)[-1] for url, _ in calls], ["session", "bots", "health", "bots", "health"])
        self.assertTrue(all(not kwargs for _, kwargs in calls))

    def test_expired_music_data_or_probe_failure_never_reuses_a_healthy_result(self):
        responses = iter([{"authenticated": True}, {"bots": [{"id": "default", "online": True}]},
                          {"generatedAt": (NOW - 121) * 1000, "bots": [{"id": "default", "status": "playing"}]}])
        client = Mock(request=lambda *_args, **_kwargs: next(responses))
        collector = ProbeCollector(http=client, now=lambda: NOW)
        probe = {"id": "music", "kind": "music", "url": "http://127.0.0.1:8787"}
        result = collector.collect(probe)[0]
        self.assertEqual(result["state"], "unknown"); self.assertIsNone(result["playing"])
        collector.http = Mock(request=Mock(side_effect=TimeoutError()))
        self.assertEqual(collector.collect(probe)[0]["state"], "unknown")

    def test_duet_single_ai_quota_and_bridge_map_existing_safe_health_shapes(self):
        cases = [
            ("ai", {"bots": [{"botId": "1", "label": "思维1", "running": True, "connected": True}, {"botId": "2", "label": "思维2", "running": True, "connected": False}], "channelId": "300"}, ["online", "offline"]),
            ("ai", {"gateway": {"running": False, "connected": False}, "chat": {"enabled": False}}, ["stopped"]),
            ("ai", {"ok": False, "gateway": {"connected": True}, "chat": {"enabled": False}}, ["unknown"]),
            ("ai", {"ok": True, "gateway": {"connected": True, "lastPongAt": iso(NOW - 121)}}, ["unknown"]),
            ("quota", {"status": "ok", "keyQueryBot": {"enabled": False}}, ["stopped"]),
            ("bridge", {"status": "ok", "queue": {"lastError": "STORAGE"}}, ["unknown"]),
            ("bridge", {"status": "ok", "queue": {"lastError": None}}, ["online"]),
        ]
        for kind, response, states in cases:
            collector = ProbeCollector(http=Mock(request=lambda *_args, **_kwargs: response), now=lambda: NOW, secrets=(TOKEN,))
            result = collector.collect({"id": "fixture", "kind": kind, "url": "http://127.0.0.1/health"})
            self.assertEqual([item["state"] for item in result], states)
        collector = ProbeCollector(secrets=(TOKEN,))
        item = collector.bot({"id": "a", "kind": "ai"}, error=TOKEN + " cookie=private https://secret.invalid/")
        self.assertNotIn(TOKEN, item["lastError"]); self.assertNotIn("private", item["lastError"])
        item = collector.bot({"id": "a", "kind": "ai"}, identifier="a:" + TOKEN)
        self.assertNotIn(TOKEN, item["id"])

    def test_operations_bot_display_name_does_not_confuse_stopped_discussion_with_its_new_role(self):
        collector = ProbeCollector(http=Mock(request=lambda *_args, **_kwargs: {"ok": True, "gateway": {"connected": True}, "chat": {"enabled": True}}))
        result = collector.collect({"id": "ops-chat", "name": "思维2·运维", "kind": "ai", "url": "http://127.0.0.1/health"})
        self.assertEqual(result[0]["name"], "思维2·运维"); self.assertEqual(result[0]["state"], "online")


class LedgerTests(TemporaryTests):
    def ledger(self, write=atomic_json):
        return CommandLedger(self.root, write=write, now=lambda: NOW).init()

    def test_restart_reserved_before_execution_and_duplicate_commands_never_restart_again(self):
        ledger = self.ledger(); seen = []
        def restart(service):
            state = json.loads(ledger.file.read_text())
            self.assertEqual(state["records"]["command-1"]["status"], "executing")
            seen.append(service["unit"]); return "succeeded"
        runner = Mock(restart=restart)
        ledger.execute(command(), {"music": SERVICE}, runner)
        ledger.execute(command(), {"music": SERVICE}, runner)
        self.assertEqual(seen, [SERVICE["unit"]]); self.assertEqual(ledger.pending()[0]["status"], "succeeded")
        ledger.acknowledge({"command-1"}); self.assertEqual(ledger.pending(), [])
        restored = self.ledger(); restored.execute(command(), {"music": SERVICE}, runner)
        self.assertEqual(seen, [SERVICE["unit"]])
        if os.name != "nt":
            self.assertEqual(ledger.file.stat().st_mode & 0o777, 0o600)

    def test_only_allowlisted_running_services_can_restart_before_command_expiry(self):
        ledger = self.ledger(); runner = Mock()
        services = {"music": SERVICE, "off": {**SERVICE, "id": "off", "expected": "stopped"}, "no": {**SERVICE, "id": "no", "restartAllowed": False}}
        values = [command("expired", expiresAt=iso(NOW - 1)), command("future", expiresAt=iso(NOW + 601)),
                  command("disabled", serviceId="off"), command("forbidden", serviceId="no"), command("other", serviceId="not-configured"),
                  command("shell", action="exec"), {**command("injected"), "command": "reboot"}, command("path", serviceId="../../evil")]
        for value in values:
            ledger.execute(value, services, runner)
        runner.restart.assert_not_called()
        self.assertTrue(all(item["status"] == "failed" for item in ledger.pending()))

    def test_restart_timeout_and_crashed_execution_become_unknown_not_a_second_restart(self):
        ledger = self.ledger(); runner = Mock(restart=Mock(side_effect=TimeoutError()))
        ledger.execute(command(), {"music": SERVICE}, runner)
        self.assertEqual(ledger.pending()[0]["status"], "unknown")
        state = {"version": 1, "records": {"crashed": {"serviceId": "music", "expiresAt": iso(NOW + 120), "createdAt": NOW, "status": "executing", "acknowledged": False}}}
        atomic_json(ledger.file, state); restored = self.ledger()
        self.assertEqual(restored.pending()[0]["status"], "unknown")
        restored.execute(command("crashed"), {"music": SERVICE}, runner)
        self.assertEqual(runner.restart.call_count, 1)

    def test_write_failures_before_or_after_restart_fail_closed_and_preserve_duplicate_protection(self):
        for failed_write in (2, 3):
            directory = self.root / str(failed_write); writes = 0
            def write(file, value):
                nonlocal writes
                writes += 1
                if writes == failed_write:
                    raise OSError("private disk path")
                atomic_json(file, value)
            ledger = CommandLedger(directory, write=write, now=lambda: NOW).init()
            runner = Mock(restart=Mock(return_value="succeeded"))
            with self.assertRaises(AgentError):
                ledger.execute(command(), {"music": SERVICE}, runner)
            self.assertEqual(runner.restart.call_count, 0 if failed_write == 2 else 1)
            ledger.execute(command("next"), {"music": SERVICE}, runner)
            self.assertEqual(runner.restart.call_count, 0 if failed_write == 2 else 1)
            if failed_write == 3:
                restored = CommandLedger(directory, now=lambda: NOW).init()
                self.assertEqual(restored.pending()[0]["status"], "unknown")

    def test_corrupt_ledger_is_not_replaced_with_an_empty_state(self):
        self.root.joinpath("commands.json").write_text("{broken", encoding="utf-8")
        with self.assertRaises(AgentError):
            self.ledger()
        self.assertEqual(self.root.joinpath("commands.json").read_text(), "{broken")

    def test_command_expiry_is_rechecked_after_durable_admission(self):
        clock, writes = NOW, 0
        def write(file, value):
            nonlocal clock, writes
            writes += 1
            atomic_json(file, value)
            if writes == 2:
                clock += 121
        ledger = CommandLedger(self.root, write=write, now=lambda: clock).init(); runner = Mock()
        ledger.execute(command(), {"music": SERVICE}, runner)
        runner.restart.assert_not_called(); self.assertEqual(ledger.pending()[0]["status"], "failed")

    def test_a_failed_acknowledgement_retains_pending_result_and_disables_new_commands(self):
        ledger = self.ledger(); runner = Mock(restart=Mock(return_value="succeeded"))
        ledger.execute(command(), {"music": SERVICE}, runner)
        ledger.write = Mock(side_effect=OSError("disk"))
        with self.assertRaises(AgentError):
            ledger.acknowledge({"command-1"})
        self.assertEqual(len(ledger.pending()), 1)
        ledger.execute(command("next"), {"music": SERVICE}, runner)
        self.assertEqual(runner.restart.call_count, 1)


class AgentTests(TemporaryTests):
    def make_agent(self, client):
        metrics = Mock(collect=lambda: {"cpuPercent": 12, "memoryPercent": 50, "diskPercent": 20, "load1": 0.1, "uptimeSeconds": 500})
        services = Mock(status=lambda service: {"id": service["id"], "activeState": "active", "subState": "running", "pid": 1, "restarts": 0, "ok": True}, restart=Mock(return_value="succeeded"))
        return Agent(config(self.root), http=client, metrics=metrics, services=services, probes=Mock(), now=lambda: NOW)

    def test_results_are_retained_on_report_failure_and_acknowledged_only_after_a_successful_report(self):
        client = Mock(); client.request.return_value = {"commands": [command()]}
        agent = self.make_agent(client); report = agent.cycle()
        self.assertEqual(report["commandResults"], [])
        self.assertEqual(client.request.call_args.args[0], "https://ops.example/ops/api/agent/report")
        self.assertEqual(client.request.call_args.kwargs["token"], TOKEN)
        self.assertNotIn(TOKEN, json.dumps(report))
        self.assertEqual(agent.ledger.pending()[0]["status"], "succeeded")
        client.request.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            agent.cycle()
        self.assertEqual(len(agent.ledger.pending()), 1)
        client.request.side_effect = None; client.request.return_value = {"commands": [command()]}
        report = agent.cycle(); self.assertEqual(len(report["commandResults"]), 1)
        self.assertEqual(agent.ledger.pending(), []); self.assertEqual(agent.services.restart.call_count, 1)

    def test_malformed_command_response_cannot_acknowledge_or_execute_results(self):
        client = Mock(request=Mock(return_value={"commands": []})); agent = self.make_agent(client)
        agent.ledger.execute(command(), agent.service_map, agent.services)
        client.request.return_value = {"commands": "reboot"}
        with self.assertRaises(AgentError):
            agent.cycle()
        self.assertEqual(len(agent.ledger.pending()), 1); self.assertEqual(agent.services.restart.call_count, 1)

    def test_a_late_report_response_cannot_execute_expired_commands(self):
        client = Mock(); clock = NOW
        agent = self.make_agent(client); agent.ledger.now = lambda: clock
        def response(*_args, **_kwargs):
            nonlocal clock
            clock += 121
            return {"commands": [command()]}
        client.request.side_effect = response
        agent.cycle(); agent.services.restart.assert_not_called()
        self.assertEqual(agent.ledger.pending()[0]["status"], "failed")

    def test_shutdown_during_report_does_not_execute_new_commands_from_its_late_response(self):
        client = Mock(); agent = self.make_agent(client)
        def response(*_args, **_kwargs):
            agent.stopping.set()
            return {"commands": [command()]}
        client.request.side_effect = response
        agent.cycle(); agent.services.restart.assert_not_called()
        self.assertEqual(agent.ledger.pending(), [])

    def test_remote_business_only_agent_never_reads_local_host_resources_or_executes_commands(self):
        client = Mock(request=Mock(return_value={"commands": [command()]}))
        metrics, services = Mock(), Mock()
        probes = Mock(collect=Mock(return_value=[{"id": "music:default", "name": "Music", "kind": "music", "state": "online", "channelName": "200", "playing": True, "lastError": ""}]))
        value = {**config(self.root), "hostId": "music-remote", "collectMetrics": False, "services": [],
                 "probes": [{"id": "music", "kind": "music", "url": "https://music.example/"}]}
        agent = Agent(value, http=client, metrics=metrics, services=services, probes=probes, now=lambda: NOW)
        report = agent.cycle()
        metrics.collect.assert_not_called(); services.status.assert_not_called(); services.restart.assert_not_called()
        self.assertEqual(report["services"], [])
        self.assertTrue(all(value is None for value in report["metrics"].values()))
        self.assertEqual(report["bots"][0]["state"], "online")
        self.assertEqual(agent.ledger.pending()[0]["status"], "failed")

    def test_remote_business_only_config_rejects_even_readonly_local_service_allowlists(self):
        for allowed in (True, False):
            with self.subTest(restartAllowed=allowed), self.assertRaises(AgentError):
                Agent({**config(self.root), "collectMetrics": False, "services": [{**SERVICE, "restartAllowed": allowed}]})


if __name__ == "__main__":
    unittest.main()
