"""Durable player bindings, daily reservations and item delivery receipts."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3
import time
from typing import Callable
import uuid
from zoneinfo import ZoneInfo


class BindingConflict(ValueError):
    pass


class NotBound(ValueError):
    pass


class Store:
    def __init__(self, path, daily_limit=3, timezone="Asia/Shanghai", now: Callable = time.time):
        self.path = str(path)
        if self.path == ":memory:":
            raise ValueError("Use a durable SQLite path, not :memory:")
        if type(daily_limit) is not int or daily_limit < 1:
            raise ValueError("daily_limit must be a positive integer")
        self.daily_limit = daily_limit
        self.timezone = ZoneInfo(timezone)
        self.now = now
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS bindings (
                    user_id TEXT PRIMARY KEY,
                    player_uid TEXT NOT NULL UNIQUE,
                    account_id TEXT NOT NULL UNIQUE,
                    player_name TEXT NOT NULL,
                    verified_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS claims (
                    message_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    player_uid TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    claim_day TEXT NOT NULL,
                    state TEXT NOT NULL,
                    quota_state TEXT NOT NULL,
                    reason TEXT NOT NULL DEFAULT '',
                    requested_text TEXT NOT NULL,
                    decision_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS claims_daily
                    ON claims(account_id, claim_day, quota_state);
                CREATE TABLE IF NOT EXISTS deliveries (
                    request_id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL REFERENCES claims(message_id),
                    position INTEGER NOT NULL,
                    item_id TEXT NOT NULL,
                    quantity INTEGER NOT NULL,
                    name TEXT NOT NULL DEFAULT '',
                    state TEXT NOT NULL,
                    message TEXT NOT NULL DEFAULT '',
                    receipt_json TEXT,
                    updated_at REAL NOT NULL,
                    UNIQUE(message_id, position)
                );
            """)

    @contextmanager
    def _db(self, write=False):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=15000")
        db.execute("PRAGMA synchronous=FULL")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _day(self):
        return datetime.fromtimestamp(self.now(), self.timezone).date().isoformat()

    def bind_verified(self, user_id, player_uid, account_id, player_name=""):
        """Call only after independent in-game ownership proof was verified."""
        user_id, account_id = str(user_id).strip(), str(account_id).strip()
        player_uid = str(player_uid).upper()
        if not user_id or not account_id or not re.fullmatch(r"[0-9A-F]{32}", player_uid):
            raise ValueError("Missing user/account or invalid player UID")
        with self._db(write=True) as db:
            existing = db.execute("SELECT * FROM bindings WHERE user_id=?", (user_id,)).fetchone()
            if existing and existing["account_id"] != account_id:
                raise BindingConflict("此 KOOK 用户已经绑定另一游戏账号，需要管理员核对后处理。")
            owner = db.execute(
                "SELECT user_id FROM bindings WHERE player_uid=? OR account_id=?",
                (player_uid, account_id),
            ).fetchone()
            if owner and owner["user_id"] != user_id:
                raise BindingConflict("此游戏账号已经绑定另一 KOOK 用户。")
            try:
                db.execute("""INSERT INTO bindings VALUES(?,?,?,?,?)
                    ON CONFLICT(user_id) DO UPDATE SET player_uid=excluded.player_uid,
                    player_name=excluded.player_name, verified_at=excluded.verified_at""",
                    (user_id, player_uid, account_id, str(player_name), self.now()))
            except sqlite3.IntegrityError as exc:
                raise BindingConflict("此游戏角色已被绑定。") from exc
        return self.binding(user_id)

    def binding(self, user_id):
        with self._db() as db:
            row = db.execute("SELECT * FROM bindings WHERE user_id=?", (str(user_id),)).fetchone()
            return dict(row) if row else None

    def _allowance(self, db, account_id, day=None):
        day = day or self._day()
        rows = db.execute("""SELECT quota_state,COUNT(*) AS n FROM claims
            WHERE account_id=? AND claim_day=? GROUP BY quota_state""", (account_id, day)).fetchall()
        counts = {r["quota_state"]: r["n"] for r in rows}
        used, reserved = counts.get("consumed", 0), counts.get("reserved", 0)
        return {"day": day, "timezone": str(self.timezone), "limit": self.daily_limit,
                "used": used, "reserved": reserved,
                "remaining": max(0, self.daily_limit - used - reserved)}

    def allowance(self, user_id):
        with self._db() as db:
            row = db.execute("SELECT account_id FROM bindings WHERE user_id=?", (str(user_id),)).fetchone()
            if not row:
                raise NotBound("请先绑定并验证你的游戏角色。")
            return self._allowance(db, row["account_id"])

    @staticmethod
    def _items(items):
        combined = {}
        for line in items:
            item_id, quantity = line.get("item_id"), line.get("quantity")
            if not isinstance(item_id, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,128}", item_id):
                raise ValueError("Invalid item_id")
            if type(quantity) is not int or not 1 <= quantity <= 2147483647:
                raise ValueError("Invalid item quantity")
            if item_id not in combined:
                combined[item_id] = {"item_id": item_id, "quantity": 0, "name": str(line.get("name", item_id))}
            combined[item_id]["quantity"] += quantity
            if combined[item_id]["quantity"] > 2147483647:
                raise ValueError("Combined quantity exceeds API bound")
        if not combined:
            raise ValueError("A grant must contain at least one item")
        return list(combined.values())

    def begin_claim(self, message_id, user_id, items, requested_text="", decision=None):
        message_id, user_id = str(message_id), str(user_id)
        if not message_id:
            raise ValueError("Missing KOOK message ID")
        with self._db(write=True) as db:
            existing = db.execute("SELECT user_id FROM claims WHERE message_id=?", (message_id,)).fetchone()
            if existing:
                if existing["user_id"] != user_id:
                    raise ValueError("Message ID belongs to another user")
                return self._claim(db, message_id)
            binding = db.execute("SELECT * FROM bindings WHERE user_id=?", (user_id,)).fetchone()
            if not binding:
                raise NotBound("请先绑定并验证你的游戏角色。")
            normalized = self._items(items)
            allowance = self._allowance(db, binding["account_id"])
            denied = allowance["remaining"] == 0
            now = self.now()
            db.execute("INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
                message_id, user_id, binding["player_uid"], binding["account_id"], allowance["day"],
                "denied" if denied else "reserved", "released" if denied else "reserved",
                "今日领取次数已用完，或仍有待核对的发放占用次数。" if denied else "",
                str(requested_text), json.dumps(decision or {}, ensure_ascii=False), now, now))
            if not denied:
                for position, line in enumerate(normalized):
                    db.execute("INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?)", (
                        uuid.uuid4().hex, message_id, position, line["item_id"], line["quantity"],
                        line["name"], "queued", "", None, now))
            return self._claim(db, message_id)

    def record_denial(self, message_id, user_id, reason, requested_text="", decision=None):
        with self._db(write=True) as db:
            existing = db.execute("SELECT user_id FROM claims WHERE message_id=?", (str(message_id),)).fetchone()
            if existing:
                if existing["user_id"] != str(user_id):
                    raise ValueError("Message ID belongs to another user")
                return self._claim(db, str(message_id))
            binding = db.execute("SELECT * FROM bindings WHERE user_id=?", (str(user_id),)).fetchone()
            now = self.now()
            db.execute("INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
                str(message_id), str(user_id), binding["player_uid"] if binding else "",
                binding["account_id"] if binding else "", self._day(), "denied", "released",
                str(reason), str(requested_text), json.dumps(decision or {}, ensure_ascii=False), now, now))
            return self._claim(db, str(message_id))

    def _claim(self, db, message_id):
        row = db.execute("SELECT * FROM claims WHERE message_id=?", (message_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["decision"] = json.loads(result.pop("decision_json"))
        result["deliveries"] = []
        for delivery in db.execute("SELECT * FROM deliveries WHERE message_id=? ORDER BY position", (message_id,)):
            item = dict(delivery)
            receipt = item.pop("receipt_json")
            item["receipt"] = json.loads(receipt) if receipt else None
            result["deliveries"].append(item)
        result["allowance"] = self._allowance(db, result["account_id"])
        return result

    def claim(self, message_id):
        with self._db() as db:
            return self._claim(db, str(message_id))

    def mark_sending(self, request_id):
        """Durably mark before HTTP POST; only the winning caller may send."""
        with self._db(write=True) as db:
            updated = db.execute("UPDATE deliveries SET state='sending',updated_at=? WHERE request_id=? AND state='queued'",
                                 (self.now(), request_id)).rowcount
            if updated:
                message_id = db.execute("SELECT message_id FROM deliveries WHERE request_id=?", (request_id,)).fetchone()[0]
                self._refresh(db, message_id)
            return bool(updated)

    def set_delivery(self, request_id, state, message="", receipt=None):
        if state not in {"pending", "submitted", "failed", "unknown"}:
            raise ValueError("Invalid receipt state")
        with self._db(write=True) as db:
            row = db.execute("SELECT * FROM deliveries WHERE request_id=?", (request_id,)).fetchone()
            if not row:
                raise KeyError(request_id)
            # A completed inventory invocation cannot be undone by a stale poll.
            if row["state"] in {"submitted", "failed", "skipped"}:
                return self._claim(db, row["message_id"])
            if row["state"] == "queued":
                raise ValueError("Unattempted delivery has no remote receipt")
            db.execute("UPDATE deliveries SET state=?,message=?,receipt_json=?,updated_at=? WHERE request_id=?", (
                state, str(message), json.dumps(receipt, ensure_ascii=False) if receipt is not None else None,
                self.now(), request_id))
            self._refresh(db, row["message_id"])
            return self._claim(db, row["message_id"])

    def skip_queued(self, message_id, reason="申请已停止，未提交此项。"):
        with self._db(write=True) as db:
            db.execute("UPDATE deliveries SET state='skipped',message=?,updated_at=? WHERE message_id=? AND state='queued'",
                       (reason, self.now(), str(message_id)))
            self._refresh(db, str(message_id))
            return self._claim(db, str(message_id))

    def _refresh(self, db, message_id):
        states = [r[0] for r in db.execute("SELECT state FROM deliveries WHERE message_id=?", (message_id,))]
        if not states:
            return
        success = "submitted" in states
        if all(s == "submitted" for s in states):
            state = "submitted"
        elif any(s in {"unknown", "sending", "pending"} for s in states):
            state = "unknown" if "unknown" in states else "in_progress"
        elif "queued" in states:
            state = "reserved"
        else:
            state = "partial" if success else "failed"
        quota = "consumed" if success else "released" if state == "failed" else "reserved"
        db.execute("UPDATE claims SET state=?,quota_state=?,updated_at=? WHERE message_id=?",
                   (state, quota, self.now(), message_id))

    def unresolved_claims(self):
        with self._db() as db:
            ids = [r[0] for r in db.execute("SELECT message_id FROM claims WHERE state IN ('reserved','in_progress','unknown') ORDER BY created_at")]
            return [self._claim(db, message_id) for message_id in ids]

