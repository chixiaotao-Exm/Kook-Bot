import errno
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

from collector import Agent, AgentError, ProbeCollector, validate_config


NOW = 1790244000
SERVICE = {"id": "music", "name": "Music", "unit": "kook-music-bot.service", "expected": "running", "restartAllowed": True}
PROBE = {"id": "music-health", "kind": "music", "url": "http://127.0.0.1:8787", "serviceId": "music"}


class RepairConfigTests(unittest.TestCase):
    def test_only_explicit_expected_running_service_mappings_are_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"hostId": "fixture", "serverUrl": "https://ops.example/ops/", "token": "fixture-" + "x" * 32,
                      "dataDir": directory, "services": [dict(SERVICE)], "probes": [dict(PROBE)]}
            normalized = validate_config(config)
            self.assertEqual(normalized["probes"][0]["serviceId"], "music")
            config["probes"][0]["serviceId"] = "altered"
            self.assertEqual(normalized["probes"][0]["serviceId"], "music")
            for service_id in ("absent", "nginx.service", "../../music", None, False, []):
                with self.subTest(service_id=service_id), self.assertRaises(AgentError):
                    validate_config({**config, "probes": [{**PROBE, "serviceId": service_id}]})
            with self.assertRaises(AgentError):
                validate_config({**config, "services": [{**SERVICE, "expected": "stopped"}], "probes": [PROBE]})
            legacy = validate_config({**config, "probes": [{key: value for key, value in PROBE.items() if key != "serviceId"}]})
            self.assertNotIn("serviceId", legacy["probes"][0])


class RepairSignalTests(unittest.TestCase):
    def collect(self, value, kind="ai", probe=None):
        configured = probe or {**PROBE, "kind": kind, "url": "http://127.0.0.1:19000/health"}
        client = Mock(request=Mock(return_value=value))
        return ProbeCollector(http=client, now=lambda: NOW).collect(configured)[0]

    def test_gateway_failure_is_explicit_and_cannot_choose_a_service_from_the_health_payload(self):
        result = self.collect({"serviceId": "nginx", "gateway": {"connected": False, "serviceId": "nginx", "botId": "1"}})
        self.assertEqual(result["id"], "music-health:1")
        self.assertEqual(result["state"], "offline")
        self.assertEqual(result["serviceId"], "music")
        self.assertEqual(result["repairReason"], "gateway_offline")
        legacy = self.collect({"gateway": {"connected": False}}, probe={"id": "legacy", "kind": "ai", "url": "http://127.0.0.1/health"})
        self.assertNotIn("serviceId", legacy)
        self.assertNotIn("repairReason", legacy)

    def test_business_errors_unknown_state_and_deliberate_stops_never_request_restart(self):
        values = [
            {"gateway": {"connected": True}, "chat": {"lastError": "MODEL_QUOTA_EXHAUSTED"}},
            {"gateway": {"connected": False, "running": False}},
            {"gateway": {"connected": False, "enabled": False}},
            {"gateway": {"connected": False}, "enabled": False},
            {"gateway": {"connected": False}, "running": False},
            {"gateway": {"connected": False}, "chat": {"enabled": False}},
            {"gateway": {}},
            {"ok": False, "gateway": {"connected": True}},
            {"gateway": {"connected": True, "lastPongAt": "2026-01-01T00:00:00Z"}},
        ]
        for value in values:
            with self.subTest(value=value):
                self.assertIsNone(self.collect(value)["repairReason"])
        self.assertEqual(self.collect({"keyQueryBot": {"connected": False}}, kind="quota")["repairReason"], "gateway_offline")
        self.assertIsNone(self.collect({"keyQueryBot": {"connected": False, "enabled": False}}, kind="quota")["repairReason"])
        self.assertIsNone(self.collect({"status": "ok", "queue": {"lastError": "API_QUOTA"}}, kind="bridge")["repairReason"])

    def test_only_local_transport_failures_are_restart_candidates(self):
        for url in ("http://127.0.0.1:19000/health", "http://localhost:19000/health", "http://[::1]:19000/health"):
            for error in (TimeoutError(), ConnectionRefusedError(errno.ECONNREFUSED, "fixture"),
                          URLError(ConnectionResetError(errno.ECONNRESET, "fixture")), AgentError("HTTP_TIMEOUT")):
                with self.subTest(url=url, error=type(error)):
                    client = Mock(request=Mock(side_effect=error))
                    result = ProbeCollector(http=client).collect({**PROBE, "kind": "ai", "url": url})[0]
                    self.assertEqual(result["state"], "unknown")
                    self.assertEqual(result["repairReason"], "health_probe_failed")
        for url in ("https://bot.example/health", "https://10.0.0.2/health"):
            result = ProbeCollector(http=Mock(request=Mock(side_effect=TimeoutError()))).collect({**PROBE, "kind": "ai", "url": url})[0]
            self.assertIsNone(result["repairReason"])

    def test_http_authentication_parse_and_configuration_errors_do_not_trigger_restarts(self):
        for error in (HTTPError(PROBE["url"], 503, "fixture", {}, None), AgentError("HTTP_FAILED"),
                      AgentError("GUEST_SESSION_UNAVAILABLE"), AgentError("INVALID_RESPONSE"),
                      ValueError("bad json"), OSError(errno.ENETUNREACH, "network unavailable"),
                      URLError("DNS unavailable"), PermissionError(errno.EACCES, "fixture")):
            with self.subTest(error=type(error), detail=str(error)):
                client = Mock(request=Mock(side_effect=error))
                result = ProbeCollector(http=client).collect({**PROBE, "kind": "ai"})[0]
                self.assertIsNone(result["repairReason"])

    def music(self, *, online=False, status="ready", age=0, issue="", transport="connected", record_status="idle", **extra):
        def request(url, **_):
            if url.endswith("/api/session"):
                return {"authenticated": True}
            if url.endswith("/api/bots"):
                return {"bots": [{"id": "default", "online": online, "status": status, **extra}]}
            return {"generatedAt": (NOW - age) * 1000,
                    "bots": [{"id": "default", "status": record_status, "transport": transport, "issue": issue}]}
        return ProbeCollector(http=Mock(request=request), now=lambda: NOW).collect(PROBE)[0]

    def test_music_requires_a_fresh_explicit_gateway_failure(self):
        self.assertEqual(self.music()["repairReason"], "gateway_offline")
        for changes in ({"age": 121}, {"status": "stopped"}, {"status": "stopping"}, {"status": "removed"},
                        {"enabled": False}, {"running": False}, {"online": None},
                        {"online": True, "issue": "音源费用不足"},
                        {"online": True, "transport": "disconnected", "record_status": "playing"},
                        {"online": True, "record_status": "paused"}):
            with self.subTest(changes=changes):
                self.assertIsNone(self.music(**changes)["repairReason"])


class RepairFreshnessTests(unittest.TestCase):
    def test_collection_deadline_and_stale_samples_clear_repair_signals(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"hostId": "fixture", "serverUrl": "https://ops.example/ops/", "token": "fixture-" + "x" * 32,
                      "dataDir": str(Path(directory)), "services": [dict(SERVICE)], "probes": [dict(PROBE)]}
            bot = {"id": "music-health:default", "kind": "music", "state": "offline", "serviceId": "music", "repairReason": "gateway_offline"}
            probes = Mock(collect=Mock(return_value=[bot]))
            agent = Agent(config, probes=probes, metrics=Mock(collect=lambda: {}),
                          services=Mock(status=lambda _: {"id": "music", "activeState": "failed", "ok": False}), now=lambda: NOW)
            with patch("collector.time.monotonic", side_effect=[0, 0, 0, 121]):
                result = agent.collect()
            self.assertEqual(result["bots"][0]["state"], "unknown")
            self.assertIsNone(result["bots"][0]["repairReason"])
            self.assertEqual(result["services"][0]["activeState"], "unknown")
            probes.collect.reset_mock()
            with patch("collector.time.monotonic", side_effect=[0, 61, 61, 61]):
                result = agent.collect()
            probes.collect.assert_not_called()
            self.assertEqual(result["bots"][0]["serviceId"], "music")
            self.assertIsNone(result["bots"][0]["repairReason"])


if __name__ == "__main__":
    unittest.main()
