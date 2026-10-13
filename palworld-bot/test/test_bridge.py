import json
from pathlib import Path
import tempfile
import unittest

from bridge import BridgeUnavailable, EventBridge
from bridge.install_telemetry import stage

try:
    from lupa import LuaRuntime
except ImportError:
    LuaRuntime = None

WORLD = "A" * 32
PLAYER = "B" * 32
OTHER = "C" * 32


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.telemetry = self.root / "telemetry"
        self.telemetry.mkdir()
        self.now = 1000
        self.data = {"info": {"worldguid": WORLD, "version": "v1.0.5.102999"},
                     "metrics": {"days": 11, "basecampnum": 1},
                     "players": {"players": [self.player(PLAYER, 20)]}}
        self.bridge = EventBridge(self.root / "events.sqlite", api=lambda name: self.data[name],
                                  telemetry_root=self.telemetry, clock=lambda: self.now)

    def tearDown(self):
        self.temp.cleanup()

    def player(self, uid, level):
        return {"playerId": uid, "name": "test", "userId": "steam_123", "level": level,
                "location_x": 1, "location_y": 2, "iP": "sensitive"}

    def write(self, data, mode="ab"):
        with (self.telemetry / "events-aabb.jsonl").open(mode) as file:
            file.write(json.dumps(data).encode() + b"\n")

    def event(self, kind="binding", **fields):
        return {"version": 1, "event_id": "aabb:1", "time": self.now,
                "type": kind, "player_uid": PLAYER, "code": "ABC123", **fields}

    def test_first_poll_does_not_announce_existing_players(self):
        snapshot = self.bridge.poll()
        self.assertEqual(snapshot["world_level"], 20)
        self.assertFalse(snapshot["progression_complete"])
        self.assertEqual(snapshot["world_day"], 11)
        self.assertEqual(snapshot["game_version"], "1.0.5.102999")
        self.assertNotIn("iP", snapshot["players"][0])
        self.assertEqual(self.bridge.events(), [])

    def test_membership_survives_restart_and_known_level_survives_offline(self):
        self.bridge.poll()
        self.now += 30
        self.data["players"] = {"players": [self.player(OTHER, 5)]}
        snapshot = self.bridge.poll()
        self.assertEqual(snapshot["world_level"], 20)
        self.assertEqual({e["type"] for e in self.bridge.events()}, {"player_leave", "player_join"})
        second = EventBridge(self.root / "events.sqlite", api=lambda name: self.data[name],
                             telemetry_root=self.telemetry, clock=lambda: self.now)
        second.poll()
        self.assertEqual(len(second.events()), 2)

    def test_failure_keeps_snapshot_but_stale_snapshot_refuses_grants(self):
        self.bridge.poll()
        self.data["players"] = {"bad": []}
        with self.assertRaises(BridgeUnavailable):
            self.bridge.poll()
        self.assertEqual(self.bridge.snapshot()["world_level"], 20)
        self.assertEqual(self.bridge.events(), [])
        self.now += 121
        with self.assertRaises(BridgeUnavailable):
            self.bridge.snapshot()

    def test_world_change_does_not_leak_old_progress(self):
        self.bridge.poll()
        self.data["info"]["worldguid"] = "D" * 32
        self.data["players"] = {"players": [self.player(OTHER, 1)]}
        self.assertEqual(self.bridge.poll()["world_level"], 1)
        self.assertEqual(self.bridge.events(), [])

    def test_binding_authority_and_durable_deduplication(self):
        self.write(self.event())
        self.bridge.poll()
        self.write(self.event())
        self.bridge.poll()
        events = self.bridge.events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["source"], "ue4ss-game-hook")
        self.assertEqual(events[0]["account_id"], "steam_123")
        self.assertEqual(self.bridge.events(after=events[0]["id"]), [])

    def test_partial_record_is_retried(self):
        raw = json.dumps(self.event()).encode() + b"\n"
        path = self.telemetry / "events-aabb.jsonl"
        path.write_bytes(raw[:40])
        self.bridge.poll()
        self.assertEqual(self.bridge.events(), [])
        with path.open("ab") as file:
            file.write(raw[40:])
        self.bridge.poll()
        self.assertEqual(len(self.bridge.events()), 1)

    def test_fake_kill_or_self_kill_rejected(self):
        self.write(self.event("player_kill", victim_uid=PLAYER))
        self.write(self.event("player_kill", event_id="aabb:2", victim_uid=PLAYER, killer_uid=PLAYER))
        self.write(self.event("announcement", event_id="aabb:3", message="A killed B"))
        self.bridge.poll()
        self.assertEqual([e["type"] for e in self.bridge.events()], ["announcement"])

    def test_kill_requires_actual_distinct_player_ids_and_marks_coordinate_units(self):
        self.write(self.event("player_kill", victim_uid=PLAYER, killer_uid=OTHER,
                              position={"x": 1, "y": 2, "z": 3}))
        self.bridge.poll()
        event = self.bridge.events()[0]
        self.assertEqual(event["position_units"], "unreal-world-centimeters")
        self.assertEqual(event["killer_uid"], OTHER)

    def test_capability_heartbeat_expires(self):
        (self.telemetry / "heartbeat.json").write_text(json.dumps({"version": 1, "time": self.now, "binding": True}))
        self.assertTrue(self.bridge.poll()["capabilities"]["binding"])
        self.now += 46
        self.assertFalse(self.bridge.poll()["capabilities"]["binding"])

    def test_duplicate_player_or_invalid_level_is_not_fabricated(self):
        self.data["players"]["players"][0]["level"] = "unknown"
        snapshot = self.bridge.poll()
        self.assertIsNone(snapshot["world_level"])
        self.data["players"]["players"].append(self.player(PLAYER, 10))
        with self.assertRaises(BridgeUnavailable):
            self.bridge.poll()

    def test_old_and_future_binding_proofs_not_ingested(self):
        self.write(self.event(time=self.now + 31))
        self.write(self.event(time=self.now - 86401, event_id="aabb:2"))
        self.bridge.poll()
        self.assertEqual(self.bridge.events(), [])

    def test_installation_does_not_replay_historical_game_notices(self):
        self.write(self.event("announcement", time=self.now-5, message="old message"))
        self.write(self.event("announcement", event_id="aabb:2", message="new message"))
        self.bridge.poll()
        self.assertEqual([e["message"] for e in self.bridge.events()], ["new message"])

    def test_installer_preserves_original_and_is_idempotent(self):
        scripts = self.root / "Scripts"
        (scripts / "libs").mkdir(parents=True)
        (scripts / "modules").mkdir()
        (scripts / "main.lua").write_text("existing-main")
        original = "local text = Message:get():ToString()\nexisting-chat-command"
        (scripts / "libs/logic.lua").write_text(original)
        stage(scripts)
        main, logic = (scripts / "main.lua").read_text(), (scripts / "libs/logic.lua").read_text()
        stage(scripts)
        self.assertEqual((scripts / "main.lua").read_text(), main)
        self.assertEqual((scripts / "libs/logic.lua").read_text(), logic)
        self.assertEqual((scripts / "libs/logic.lua.pre-kook").read_text(), original)
        self.assertIn("existing-chat-command", logic)
        self.assertIn("deaths=false", main)
        stage(scripts, enable_deaths=True)
        self.assertIn("deaths=true", (scripts / "main.lua").read_text())


@unittest.skipUnless(LuaRuntime, "optional Lua runtime unavailable")
class LuaObserverTests(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(unpack_returned_tuples=True)

        def convert(value):
            if hasattr(value, "items"):
                return {str(k): convert(v) for k, v in value.items()}
            return value

        self.lua.globals().encode_json = lambda value: json.dumps(convert(value))
        self.lua.execute('''
            files, hooks, timers = {}, {}, {}
            io.open = function(path, mode)
                local stream = {path=path, mode=mode}
                function stream:read(_) return "aabb-ccdd\\n" end
                function stream:write(value)
                    files[self.path] = (self.mode == "ab" and (files[self.path] or "") or "") .. value
                    return self
                end
                function stream:flush() return true end
                function stream:close() return true end
                return stream
            end
            os.rename = function(a,b) files[b]=files[a];files[a]=nil;return true end
            os.time = function() return 1000 end
            RegisterHook = function(name, fn) hooks[name] = fn end
            ExecuteInGameThreadWithDelay = function(_, fn) timers[#timers+1]=fn end
            package.preload["libs/Json"] = function() return {encode=encode_json} end
            package.preload["libs/utils"] = function() return {announce=function(pc, message)
                assert(pc.PlayerState and pc.PlayerState.PlayerUId, "Expected controller, not state")
            end} end
            function text(value) return {ToString=function() return value end} end
            function parameter(value) return {get=function() return value end} end
            function state(a, name)
                return {IsValid=function() return true end, PlayerUId={A=a,B=0,C=0,D=0},
                        GetPlayerName=function() return text(name) end}
            end
        ''')
        module = Path(__file__).parents[1] / "bridge/kook_telemetry.lua"
        self.lua.globals().observer = self.lua.execute(module.read_text(encoding="utf-8"))

    def events(self):
        data = self.lua.globals().files["/mock/events-aabb-ccdd.jsonl"] or ""
        return [json.loads(line) for line in data.splitlines()]

    def test_binding_records_exact_sender_only_and_preserves_no_regular_chat(self):
        self.lua.execute('''
            observer.start({root="/mock"})
            local pc = {PlayerState=state(-1,"player")}
            observer.onChat(pc, "!bind ABCDEF1234")
            observer.onChat(pc, "!绑定 A1B2C3D4E5")
            observer.onChat(pc, "ordinary chat is not recorded")
        ''')
        events = self.events()
        self.assertEqual([e["code"] for e in events], ["ABCDEF1234", "A1B2C3D4E5"])
        self.assertEqual(events[0]["player_uid"], "FFFFFFFF" + "0" * 24)
        heartbeat = json.loads(self.lua.globals().files["/mock/heartbeat.json"])
        self.assertTrue(heartbeat["binding"])
        self.assertFalse(heartbeat["player_kills"])

    def test_actual_announcement_parameter_and_optional_death_evidence(self):
        self.lua.execute('''
            observer.start({root="/mock",deaths=true})
            hooks["/Script/Pal.PalUtility:SendSystemAnnounce"](nil,nil,parameter(text("server notice")))
            local victim = {IsValid=function() return true end, PlayerState=state(1,"B"),
                K2_GetActorLocation=function() return {X=12,Y=23,Z=34} end}
            local attacker = {IsValid=function() return true end, PlayerState=state(2,"A")}
            hooks["/Script/Pal.PalCharacter:OnDeadCharacter"](nil,parameter({SelfActor=victim,LastAttacker=attacker}))
            hooks["/Script/Pal.PalCharacter:OnDeadCharacter"](nil,parameter({SelfActor=victim}))
        ''')
        events = self.events()
        self.assertEqual([e["type"] for e in events], ["announcement", "player_kill", "player_death"])
        self.assertEqual(events[1]["killer_name"], "A")
        self.assertEqual(events[1]["victim_name"], "B")
        self.assertEqual(events[1]["position"], {"x": 12, "y": 23, "z": 34})
        self.assertNotIn("killer_uid", events[2])

    def test_unavailable_announcement_hook_does_not_disable_binding(self):
        self.lua.execute('''
            RegisterHook = function() error("unavailable") end
            observer.start({root="/mock",deaths=true})
            observer.onChat({PlayerState=state(1,"player")}, "!bind ABCDEF1234")
        ''')
        self.assertEqual(len(self.events()), 1)
        heartbeat = json.loads(self.lua.globals().files["/mock/heartbeat.json"])
        self.assertFalse(heartbeat["announcements"])
        self.assertFalse(heartbeat["player_deaths"])


if __name__ == "__main__":
    unittest.main()
