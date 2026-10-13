"""Private, same-host REST telemetry + append-only UE4SS event reader.

No game writes, save modifications, shell commands, or automatic game restarts.
The REST progression is a *known lower bound*, not a claim about offline saves.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import json
import math
from pathlib import Path
import re
import sqlite3
import time
import urllib.request


class BridgeUnavailable(RuntimeError):
    pass


def _uid(value):
    value = str(value or "").replace("-", "").upper()
    return value if re.fullmatch(r"[A-F0-9]{32}", value) and int(value, 16) else None


def _number(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def _level(value):
    return int(value) if _number(value) and int(value) == value and 1 <= value <= 1000 else None


def _short(value, limit=200):
    return value[:limit] if isinstance(value, str) else ""


class EventBridge:
    def __init__(self, db_path, game_base="/opt/palworld", api=None,
                 telemetry_root=None, max_age=120, clock=time.time):
        self.game_base = Path(game_base)
        self.root = Path(telemetry_root) if telemetry_root else self.game_base / "ue4ss/kook"
        self.db_path = str(db_path)
        self.api = api or self._api
        self.max_age = max_age
        self.clock = clock
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS levels (
                  world_id TEXT NOT NULL, player_uid TEXT NOT NULL, level INTEGER NOT NULL,
                  PRIMARY KEY(world_id,player_uid));
                CREATE TABLE IF NOT EXISTS events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL,
                  payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS offsets (
                  path TEXT PRIMARY KEY, identity TEXT NOT NULL, position INTEGER NOT NULL);
            """)
            if self._get(db, "event_origin") is None:
                self._put(db, "event_origin", int(self.clock()))

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _api(self, endpoint):
        if endpoint not in ("players", "info", "metrics"):
            raise ValueError("read-only API endpoint required")
        secret = json.loads((self.game_base / "secrets.json").read_text())["admin_password"]
        auth = base64.b64encode(("admin:" + secret).encode()).decode()
        request = urllib.request.Request("http://127.0.0.1:18211/v1/api/" + endpoint,
                                         headers={"Authorization": "Basic " + auth})
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                content = response.read(2_000_001)
                if len(content) > 2_000_000:
                    raise BridgeUnavailable("Game API response exceeds limit")
                return json.loads(content)
        except Exception:
            raise BridgeUnavailable("游戏状态接口暂时不可用") from None

    @staticmethod
    def _get(db, key, default=None):
        row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    @staticmethod
    def _put(db, key, value):
        db.execute("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, json.dumps(value, ensure_ascii=False)))

    @staticmethod
    def _event(db, event_key, payload):
        db.execute("INSERT OR IGNORE INTO events(event_key,payload) VALUES (?,?)",
                   (event_key, json.dumps(payload, ensure_ascii=False)))

    def poll(self):
        # All reads succeed before changing online membership: an outage must
        # never turn into a fabricated mass disconnect or zero-level world.
        try:
            info, metrics, response = self.api("info"), self.api("metrics"), self.api("players")
        except Exception:
            raise BridgeUnavailable("游戏状态接口暂时不可用") from None
        world_id = _uid(info.get("worldguid")) if isinstance(info, dict) else None
        if not world_id or not isinstance(metrics, dict) or not isinstance(response, dict) or not isinstance(response.get("players"), list):
            raise BridgeUnavailable("游戏状态数据不完整")
        players, seen = [], set()
        for row in response["players"]:
            if not isinstance(row, dict):
                raise BridgeUnavailable("在线玩家数据不完整")
            uid = _uid(row.get("playerId"))
            if not uid or uid in seen:
                raise BridgeUnavailable("在线玩家身份无效或重复")
            seen.add(uid)
            player = {"player_uid": uid, "name": _short(row.get("name")),
                      "account_id": _short(row.get("userId"), 128), "level": _level(row.get("level"))}
            for source, key in (("location_x", "x"), ("location_y", "y")):
                if _number(row.get(source)):
                    player[key] = row[source]
            players.append(player)
        now = self.clock()
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = self._get(db, "snapshot")
            if previous and previous.get("world_id") != world_id:
                self._put(db, "event_origin", int(now))
            known = {row["player_uid"]: row["level"] for row in db.execute(
                "SELECT player_uid,level FROM levels WHERE world_id=?", (world_id,))}
            for p in players:
                if p["level"] is not None:
                    known[p["player_uid"]] = max(known.get(p["player_uid"], 0), p["level"])
                    db.execute("INSERT INTO levels VALUES (?,?,?) ON CONFLICT(world_id,player_uid) DO UPDATE SET level=MAX(level,excluded.level)",
                               (world_id, p["player_uid"], p["level"]))
            # First observation (including a changed world) establishes baseline.
            if previous and previous.get("world_id") == world_id:
                before = {p["player_uid"]: p for p in previous["players"]}
                after = {p["player_uid"]: p for p in players}
                for kind, keys, members in (("player_join", after.keys() - before.keys(), after),
                                            ("player_leave", before.keys() - after.keys(), before)):
                    for uid in sorted(keys):
                        event = {"type": kind, "time": now, "world_id": world_id,
                                 "source": "official-rest-player-list", **members[uid]}
                        self._event(db, f"rest:{world_id}:{kind}:{uid}:{now}", event)
            snapshot = {"version": 1, "observed_at": now, "world_id": world_id,
                        "world_level": max(known.values()) if known else None,
                        "player_levels": {p["player_uid"]: p["level"] for p in players},
                        "known_player_levels": known, "players": players,
                        "world_day": metrics.get("days") if _number(metrics.get("days")) else None,
                        "base_count": metrics.get("basecampnum") if _number(metrics.get("basecampnum")) else None,
                        "server_version": _short(info.get("version")),
                        "game_version": _short(info.get("version")).removeprefix("v"),
                        "server_uptime": metrics.get("uptime") if _number(metrics.get("uptime")) else None,
                        "source": "official-rest; world_level=max observed player level in this world",
                        "progression_complete": False, "unlocked_technologies": None,
                        "defeated_bosses": None, "capabilities": self._capabilities(now)}
            self._put(db, "snapshot", snapshot)
            self._ingest(db, now, players, world_id)
        return snapshot

    def _capabilities(self, now):
        result = {"online_players": True, "world_day": True, "world_level_is_lower_bound": True,
                  "binding": False, "announcements": False, "player_deaths": False,
                  "player_kills": False, "complete_save_progression": False}
        try:
            path = self.root / "heartbeat.json"
            if path.stat().st_size > 8192:
                return result
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("version") == 1 and _number(data.get("time")) and -10 <= now - data["time"] <= 45:
                for key in ("binding", "announcements", "player_deaths", "player_kills"):
                    result[key] = data.get(key) is True
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        return result

    def _ingest(self, db, now, players, world_id):
        current = {p["player_uid"]: p for p in players}
        origin = self._get(db, "event_origin", int(now))
        # Boot-specific files avoid lost unread records when UE4SS restarts.
        for path in sorted(self.root.glob("events-*.jsonl")):
            if not re.fullmatch(r"events-[a-f0-9-]{1,80}\.jsonl", path.name) or path.is_symlink():
                continue
            stat = path.stat()
            identity = f"{stat.st_dev}:{stat.st_ino}"
            row = db.execute("SELECT identity,position FROM offsets WHERE path=?", (path.name,)).fetchone()
            offset = row["position"] if row and row["identity"] == identity and stat.st_size >= row["position"] else 0
            with path.open("rb") as stream:
                stream.seek(offset)
                for _ in range(1000):
                    start = stream.tell()
                    line = stream.readline(16385)
                    if not line:
                        break
                    if not line.endswith(b"\n"):
                        # A partial tail is retried. Oversize records are skipped
                        # through their newline without parsing embedded suffixes.
                        if len(line) > 16384:
                            while line and not line.endswith(b"\n"):
                                line = stream.readline(16385)
                            offset = stream.tell()
                            continue
                        offset = start
                        break
                    offset = stream.tell()
                    try:
                        raw = json.loads(line)
                        event = self._validate_event(raw, now)
                    except (ValueError, TypeError, AttributeError):
                        continue
                    if event:
                        if event["time"] < origin:
                            continue
                        uid = event.get("player_uid") or event.get("victim_uid")
                        if uid in current:
                            event.setdefault("player_name", current[uid]["name"])
                            event.setdefault("account_id", current[uid]["account_id"])
                        for key in ("victim", "killer"):
                            member = current.get(event.get(key + "_uid"))
                            if member and not event.get(key + "_name"):
                                event[key + "_name"] = member["name"]
                        event["world_id"] = world_id
                        self._event(db, "lua:" + raw["event_id"], event)
            db.execute("INSERT INTO offsets VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET identity=excluded.identity,position=excluded.position",
                       (path.name, identity, offset))

    @staticmethod
    def _validate_event(raw, now):
        if not isinstance(raw, dict) or raw.get("version") != 1:
            return None
        event_id = raw.get("event_id")
        if not isinstance(event_id, str) or not re.fullmatch(r"[a-f0-9-]{1,80}:\d{1,12}", event_id):
            return None
        stamp = raw.get("time")
        if not _number(stamp) or stamp > now + 30 or now - stamp > 86400:
            return None
        kind = raw.get("type")
        event = {"type": kind, "time": stamp, "source": "ue4ss-game-hook", "source_event_id": event_id}
        if kind == "binding":
            uid, code = _uid(raw.get("player_uid")), raw.get("code")
            if not uid or not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9]{6,32}", code):
                return None
            event.update(player_uid=uid, code=code)
        elif kind == "announcement":
            message = _short(raw.get("message"), 2000)
            if not message.strip():
                return None
            event["message"] = message
        elif kind in ("player_death", "player_kill"):
            victim = _uid(raw.get("victim_uid"))
            if not victim:
                return None
            event.update(victim_uid=victim, victim_name=_short(raw.get("victim_name")))
            killer = _uid(raw.get("killer_uid"))
            # A death with no separately established attacker is never a kill.
            if kind == "player_kill":
                if not killer or killer == victim:
                    return None
                event.update(killer_uid=killer, killer_name=_short(raw.get("killer_name")))
            position = raw.get("position")
            if isinstance(position, dict) and all(_number(position.get(k)) for k in ("x", "y", "z")):
                event["position"] = {k: position[k] for k in ("x", "y", "z")}
                event["location"] = event["position"]
                event["position_units"] = "unreal-world-centimeters"
        else:
            return None
        return event

    def snapshot(self):
        with self._db() as db:
            snapshot = self._get(db, "snapshot")
        if not snapshot or not -10 <= self.clock() - snapshot["observed_at"] <= self.max_age:
            raise BridgeUnavailable("世界进度尚未更新或已过期，暂不发放物资")
        return snapshot

    def events(self, after=0, limit=100):
        if not isinstance(after, int) or after < 0:
            raise ValueError("invalid event cursor")
        limit = max(1, min(int(limit), 1000))
        with self._db() as db:
            return [{**json.loads(row["payload"]), "id": row["id"]} for row in db.execute(
                "SELECT id,payload FROM events WHERE id>? ORDER BY id LIMIT ?", (after, limit))]
