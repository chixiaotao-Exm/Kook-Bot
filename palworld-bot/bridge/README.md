# Private game telemetry

`EventBridge(db_path).poll()` reads the official local `info`, `metrics`, and
`players` endpoints and imports structured events. The API credential is read
from the game's private `secrets.json`; it is never returned. `snapshot()` fails
after 120 seconds without a successful poll. `events(after, limit)` returns a
durable monotonically increasing cursor. The caller must persist its cursor
after handling each event, and deduplicate side effects by the event ID.
The observer establishes a durable event origin on its first installation and
when the world ID changes, so old game files are not replayed as new notices.

The snapshot includes the server's actual day, base count, live player levels,
and the highest player level observed in the current world. That last number
is a known lower bound, **not** all offline players or technology/boss completion.
The bot must not fabricate these missing progression signals. Read failures do
not produce leave events or replace a valid snapshot with zeros. Initial polling
establishes online membership without replaying historical join notifications.

For binding and game announcements, stage `kook_telemetry.lua` inside the existing
MinimalGive mod using `install_telemetry.py`. Create `/opt/palworld/ue4ss/kook` with
write access for the game process; the container sees this as
`/pal/Package/Pal/Binaries/Linux/ue4ss/kook`. This directory is private. One planned
game restart is required; staging alone does not change the running process.
The change is additive, uses the existing chat hook, and preserves item commands.
`!bind CODE` and `!绑定 CODE` emit the actual sending player's UID; the bot must
validate its own challenge, expiry, and one-user/one-player binding rule.
Ordinary game chat is not recorded.

The observer registers the native `PalUtility:SendSystemAnnounce` method, whose
call signature is already used by this deployment's MinimalGive utility. It
relays only announcements which traverse that method. Hook registration is not
proof that every game UI message traverses it. Capabilities expire if the game
heartbeat stops; unsupported hooks fail independently of item delivery.

Player deaths are opt-in (`--enable-deaths` when staging). The event layout
`PalCharacter:OnDeadCharacter` → `SelfActor`/`LastAttacker` is documented in
[dkoz/AdminCommands](https://github.com/dkoz/AdminCommands/blob/main/AdminCommands/Scripts/libs/serverlogs.lua).
It has not yet been exercised on this deployment. Only direct player-state
evidence on the attacker produces a PvP kill. Other deaths omit the killer.
Locations are Unreal world coordinates in centimeters, not invented named
regions. Default deployment leaves this optional hook disabled until verified.

The SQLite ledger deduplicates hook records by boot/sequence ID. Partial JSONL
tails are retried, malformed records rejected, and unverified textual kill
messages are never parsed as game evidence. Boot-specific files can be archived
after all consumers have advanced beyond them; do not delete unread files.
