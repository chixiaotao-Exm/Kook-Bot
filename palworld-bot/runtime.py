"""Durable inbox, game event cursor and short-lived ownership challenges."""
import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager


class Runtime:
    def __init__(self, path, now=time.time):
        self.path, self.now = str(path), now
        with self.db() as db:
            db.executescript('''
              PRAGMA journal_mode=WAL;
              CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, body TEXT NOT NULL, state TEXT NOT NULL, created REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS challenges (digest TEXT PRIMARY KEY, user_id TEXT NOT NULL, player_uid TEXT NOT NULL, quote TEXT NOT NULL, expires REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS event_attempts (event_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, updated REAL NOT NULL);
            ''')
            db.execute("UPDATE inbox SET state='queued' WHERE state='processing'")

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA synchronous=FULL')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def enqueue(self, event):
        with self.db() as db:
            return bool(db.execute('INSERT OR IGNORE INTO inbox VALUES(?,?,?,?)',
                (event['msg_id'], json.dumps(event, ensure_ascii=False), 'queued', self.now())).rowcount)

    def next(self):
        with self.db() as db:
            row = db.execute("SELECT * FROM inbox WHERE state='queued' ORDER BY created LIMIT 1").fetchone()
            if not row:
                return None
            db.execute("UPDATE inbox SET state='processing' WHERE id=?", (row['id'],))
            return json.loads(row['body'])

    def done(self, event_id):
        with self.db() as db:
            # Retain only dedupe ID after processing, not the user's whole message.
            db.execute("UPDATE inbox SET state='done',body='{}' WHERE id=?", (event_id,))

    def challenge(self, user_id, player_uid, quote):
        code = secrets.token_hex(5).upper()
        with self.db() as db:
            db.execute('DELETE FROM challenges WHERE user_id=? OR expires<?', (str(user_id), self.now()))
            db.execute('INSERT INTO challenges VALUES(?,?,?,?,?)',
                (hashlib.sha256(code.encode()).hexdigest(), str(user_id), player_uid, quote, self.now() + 600))
        return code

    def proof(self, code, player_uid):
        digest = hashlib.sha256(code.upper().encode()).hexdigest()
        with self.db() as db:
            row = db.execute('SELECT * FROM challenges WHERE digest=? AND player_uid=? AND expires>?',
                (digest, player_uid, self.now())).fetchone()
            return dict(row) if row else None

    def consume_proof(self, digest):
        with self.db() as db:
            db.execute('DELETE FROM challenges WHERE digest=?', (digest,))

    def get(self, key, default=None):
        with self.db() as db:
            row = db.execute('SELECT value FROM kv WHERE key=?', (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def put(self, key, value):
        with self.db() as db:
            db.execute('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                (key, json.dumps(value, ensure_ascii=False)))

    def allow_event_delivery(self, event_key, max_attempts=3):
        """Bound transient KOOK failures; never resend one event forever."""
        event_key = str(event_key)
        with self.db() as db:
            row = db.execute('SELECT attempts FROM event_attempts WHERE event_key=?', (event_key,)).fetchone()
            attempts = int(row[0]) if row else 0
            if attempts >= max_attempts:
                return False
            attempts += 1
            db.execute('INSERT INTO event_attempts VALUES(?,?,?) ON CONFLICT(event_key) DO UPDATE SET attempts=excluded.attempts,updated=excluded.updated',
                       (event_key, attempts, self.now()))
            return True


def event_text(event):
    def name(key):
        return str(event.get(key, '未知玩家'))[:80]
    kind = event['type']
    if kind == 'player_join':
        return f"🟢 {name('name')} 加入了世界。"
    if kind == 'player_leave':
        return f"⚪ {name('name')} 离开了世界。"
    if kind == 'announcement':
        return '📢 游戏公告\n' + str(event.get('message', event.get('text', '')))[:1800]
    if kind in ('player_kill', 'player_death'):
        location = event.get('position', event.get('location'))
        where = ''
        if isinstance(location, dict) and all(type(location.get(k)) in (int, float) for k in ('x', 'y')):
            where = f"在世界坐标 ({location['x']:.0f}, {location['y']:.0f}) 厘米 "
        if kind == 'player_kill' and event.get('killer_name') and event.get('victim_name'):
            return f"⚔️ {name('killer_name')} {where}击败了玩家 {name('victim_name')}。"
        if event.get('victim_name'):
            return f"💀 玩家 {name('victim_name')} {where}死亡。"
    return None
