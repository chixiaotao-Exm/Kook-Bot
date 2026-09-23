"""Private JSON-lines bridge for qqmusic-api-python 0.7.2; no listening port."""
import asyncio
import base64
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urljoin, urlsplit

RPC_OUT = sys.stdout
sys.stdout = sys.stderr
os.umask(0o077)

try:
    from qqmusic_api import Client, Credential
    from qqmusic_api.models.login import QRLoginType, QRCodeLoginEvents
    from qqmusic_api.modules.song import SongFileInfo, SongFileType
    SDK_READY = True
except ImportError:
    SDK_READY = False


class ProviderError(Exception):
    def __init__(self, code):
        self.code = code


def obj(value):
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return value if isinstance(value, dict) else {}


def text(value, limit=160):
    return re.sub(r"<[^>]*>", "", str(value or ""))[:limit]


def image_url(value):
    try:
        url = urlsplit(str(value))
        if url.scheme in ("http", "https") and not url.username and not url.password and (
            url.hostname in ("y.gtimg.cn", "qpic.y.qq.com") or url.hostname.endswith(".gtimg.cn")
            or url.hostname == "qpic.cn" or url.hostname.endswith(".qpic.cn")
            or url.hostname == "qlogo.cn" or url.hostname.endswith(".qlogo.cn")
        ):
            return str(value).replace("http://", "https://", 1)
    except (ValueError, AttributeError):
        pass
    return ""


def song(value):
    item = obj(value)
    album = obj(item.get("album"))
    mid = str(item.get("mid") or "")
    identifier = str(item.get("id") or mid)
    if not re.fullmatch(r"(?:[1-9]\d{0,18}|[A-Za-z0-9]{14})", identifier):
        raise ProviderError("input")
    cover = value.cover_url() if hasattr(value, "cover_url") else ""
    if not cover and re.fullmatch(r"[A-Za-z0-9]+", str(album.get("mid") or "")):
        cover = "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + album["mid"] + ".jpg"
    return {"id": identifier, "mid": mid, "source": "qq", "name": text(item.get("name") or item.get("title")) or "未知歌曲",
            "artists": text(" / ".join(text(obj(s).get("name")) for s in item.get("singer", []))) or "未知歌手",
            "durationMs": max(0, int(item.get("interval") or 0) * 1000), "cover": image_url(cover),
            "album": text(album.get("name") or album.get("title"))}


def playlist(value, chart=False):
    item = obj(value)
    creator = item.get("creator") or item.get("nickname") or item.get("creator_nick") or ""
    if not isinstance(creator, str):
        creator = obj(creator).get("name") or obj(creator).get("nick") or obj(creator).get("nickname") or ""
    return {"id": ("top:" if chart else "") + str(item.get("id") or item.get("tid") or 0), "source": "qq",
            "name": text(item.get("title") or item.get("name")),
            "cover": image_url(item.get("picurl") or item.get("front_pic_url") or item.get("head_pic_url") or ""),
            "trackCount": max(0, int(item.get("songnum") or item.get("total_num") or 0)),
            "playCount": max(0, int(item.get("listennum") or item.get("listen_num") or 0)),
            "description": text(item.get("desc") or item.get("intro"), 2000), "creator": text(creator)}


def count(value, default, maximum=100):
    number = default if value is None else value
    if not isinstance(number, int) or isinstance(number, bool) or number < 1 or number > maximum:
        raise ProviderError("input")
    return number


class Provider:
    def __init__(self, directory):
        self.directory = directory
        self.file = directory / "qq-credential.json"
        self.client = None
        self.lock = asyncio.Lock()
        self.qr = None
        self.qr_expires = 0
        self.qr_status = "none"
        self.qr_checked = 0
        self.qr_poll = None
        self.verified_at = 0
        self.expired = False
        self.bad_file = False

    async def init(self):
        if self.client:
            return
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        credential = Credential()
        if self.file.exists():
            try:
                credential = Credential.model_validate_json(self.file.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                self.bad_file = True
        client = Client(credential, device_path=str(self.directory / "qq-device.json"), rate=4, capacity=8)
        try:
            await client.__aenter__()
        except BaseException as error:
            # A failed/cancelled startup must not make later requests reuse a
            # partially initialized client or leave its HTTP resources open.
            try:
                await client.__aexit__(type(error), error, error.__traceback__)
            except BaseException:
                pass
            raise
        self.client = client

    def save_credential(self, credential):
        temporary = self.file.with_suffix(".tmp")
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(credential.model_dump_json(by_alias=True))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.file)
            os.chmod(self.file, 0o600)
        finally:
            temporary.unlink(missing_ok=True)
        self.client.credential = credential
        self.bad_file = False
        self.expired = False
        self.verified_at = time.monotonic()

    async def credential(self, required=False):
        async with self.lock:
            credential = self.client.credential
            if not credential.musicid or not credential.musickey:
                if required:
                    raise ProviderError("credential_file" if self.bad_file else "login")
                return None
            if time.monotonic() - self.verified_at < 60:
                if self.expired:
                    if required:
                        raise ProviderError("login")
                    return None
                return credential
            expired = await self.client.login.check_expired(credential)
            if expired and credential.refresh_key and credential.refresh_token:
                try:
                    credential = await self.client.login.refresh_credential(credential)
                    self.save_credential(credential)
                    expired = False
                except Exception:
                    expired = True
            self.expired = expired
            self.verified_at = time.monotonic()
            if expired:
                if required:
                    raise ProviderError("login")
                return None
            return credential

    async def search(self, keywords, limit):
        result = await self.client.search.search_by_type(keywords, search_type=0, num=limit, page=1, highlight=False)
        return [song(item) for item in result.song[:limit]]

    async def detail(self, identifier):
        if not re.fullmatch(r"(?:[1-9]\d{0,18}|[A-Za-z0-9]{14})", identifier):
            raise ProviderError("input")
        result = await self.client.song.get_detail(int(identifier) if identifier.isdecimal() else identifier)
        return result.track

    async def playlist_page(self, identifier, offset, limit):
        chart = identifier.startswith("top:")
        numeric = identifier[4:] if chart else identifier
        if not re.fullmatch(r"[1-9]\d{0,18}", numeric) or not isinstance(offset, int) or offset < 0 or offset > 100000:
            raise ProviderError("input")
        # The SDK accepts page/num, so at most two fixed pages cover an arbitrary offset.
        page_size = 100
        first_page = offset // page_size + 1
        start = offset % page_size
        fetch_page = self.client.top.get_detail if chart else self.client.songlist.get_detail
        result = await fetch_page(int(numeric), num=page_size, page=first_page)
        songs = list(result.songs)
        total = int(result.info.total_num if chart else result.total)
        if start + limit > page_size and first_page * page_size < total:
            following = await fetch_page(int(numeric), num=page_size, page=first_page + 1)
            songs.extend(following.songs)
        info = playlist(result.info, chart)
        info["id"] = identifier
        info["trackCount"] = total
        return {"playlist": info, "tracks": [song(item) for item in songs[start:start + limit]],
                "total": total, "offset": offset, "limit": limit, "hasMore": offset + limit < total}

    async def import_playlist(self, identifier, limit):
        songs = []
        for offset in range(0, limit, 100):
            page = await self.playlist_page(identifier, offset, min(100, limit - offset))
            songs.extend(page["tracks"])
            if not page["hasMore"]:
                break
        return songs[:limit]

    async def discover(self, category):
        if category == "charts":
            result = await self.client.top.get_category()
            return [playlist(item, True) for group in result.group for item in group.toplist][:24]
        if category == "mine":
            credential = await self.credential(True)
            result = await self.client.user.get_created_songlist(credential.musicid, credential=credential)
            return [playlist(item) for item in result.playlists[:50]]
        if category == "acg":
            result = await self.client.search.search_by_type("ACG 动漫", search_type=3, num=16, page=1, highlight=False)
            return [playlist(item) for item in result.songlist[:16]]
        if category != "hot":
            raise ProviderError("input")
        result = await self.client.recommend.get_recommend_songlist(num=16)
        return [playlist(item) for item in result.songlists[:16]]

    async def account(self):
        credential = await self.credential()
        if not credential:
            return {"loggedIn": False, "expired": self.expired or self.bad_file}
        name = "QQ 音乐用户"
        avatar = ""
        euin = credential.encrypt_uin
        if euin:
            try:
                info = (await self.client.user.get_homepage(euin, credential=credential)).base_info
                name = text(info.name) or name
                avatar = image_url(info.avatar)
            except Exception:
                pass
        return {"loggedIn": True, "expired": False, "id": str(credential.musicid), "name": name, "avatar": avatar}

    async def qr_create(self, kind):
        if kind not in ("qq", "wx"):
            raise ProviderError("input")
        async with self.lock:
            if self.qr_poll:
                self.qr_poll.cancel()
                self.qr_poll = None
            self.qr = await self.client.login.get_qrcode(QRLoginType(kind))
            if not self.qr.data or len(self.qr.data) > 512000:
                raise ProviderError("qr")
            mime = self.qr.mimetype
            if mime not in ("image/png", "image/jpeg"):
                raise ProviderError("qr")
            self.qr_expires = int(time.time() * 1000) + 180000
            self.qr_status = "waiting"
            self.qr_checked = 0
            return {"image": "data:" + mime + ";base64," + base64.b64encode(self.qr.data).decode("ascii"),
                    "expires": self.qr_expires, "status": "waiting"}

    async def qr_check(self):
        if not self.qr or self.qr_status in ("success", "expired", "refused"):
            return {"status": self.qr_status}
        if time.time() * 1000 >= self.qr_expires:
            self.qr_status = "expired"
            if self.qr_poll:
                self.qr_poll.cancel()
            return {"status": "expired"}
        if (self.qr_poll is None or self.qr_poll.done()) and time.monotonic() - self.qr_checked >= 2:
            self.qr_checked = time.monotonic()
            self.qr_poll = asyncio.create_task(self.poll_qr(self.qr))
        return {"status": self.qr_status}

    async def poll_qr(self, qrcode):
        # WeChat holds its long poll for up to 35 seconds. Do not hold the RPC or credential lock.
        try:
            result = await asyncio.wait_for(self.client.login.check_qrcode(qrcode), timeout=40)
        except asyncio.CancelledError:
            return
        except Exception:
            return
        async with self.lock:
            if self.qr is not qrcode or time.time() * 1000 >= self.qr_expires:
                return
            states = {QRCodeLoginEvents.SCAN: "waiting", QRCodeLoginEvents.CONF: "scanned",
                      QRCodeLoginEvents.TIMEOUT: "expired", QRCodeLoginEvents.REFUSE: "refused"}
            if result.event == QRCodeLoginEvents.DONE:
                if not result.credential or not result.credential.musicid or not result.credential.musickey:
                    self.qr_status = "expired"
                    return
                try:
                    self.save_credential(result.credential)
                except OSError:
                    self.qr_status = "expired"
                    return
                self.qr_status = "success"
            else:
                self.qr_status = states.get(result.event, "expired")

    async def stream(self, identifier):
        credential = await self.credential(required=True)
        track = await self.detail(identifier)
        item = obj(track)
        mid = str(item.get("mid") or "")
        media_mid = obj(item.get("file")).get("media_mid") or None
        if not re.fullmatch(r"[A-Za-z0-9]{14}", mid):
            raise ProviderError("unavailable")
        result = await self.client.song.get_song_urls(
            [SongFileInfo(mid=mid, media_mid=media_mid, song_type=item.get("type") or 0)],
            file_type=SongFileType.MP3_128, credential=credential)
        entry = next((entry for entry in result.data if entry.mid == mid), None)
        if not entry or entry.result != 0 or not entry.purl or entry.ekey:
            raise ProviderError("unavailable")
        if not re.fullmatch(r"M500[A-Za-z0-9]+\.mp3", entry.filename):
            raise ProviderError("unavailable")
        dispatch = await self.client.song.get_cdn_dispatch()
        for cdn in dispatch.sip:
            url = urljoin(cdn, entry.purl)
            parts = urlsplit(url)
            if parts.scheme in ("http", "https") and not parts.username and not parts.password and (
                parts.hostname == "stream.qqmusic.qq.com" or (parts.hostname or "").endswith(".stream.qqmusic.qq.com")
            ) and re.fullmatch(r"/M500[A-Za-z0-9]+\.mp3", parts.path):
                return {"url": url, "full": True, "preview": False}
        raise ProviderError("unavailable")

    async def lyrics(self, identifier):
        if not re.fullmatch(r"(?:[1-9]\d{0,18}|[A-Za-z0-9]{14})", identifier):
            raise ProviderError("input")
        # SDK 0.7.2 returns decrypted strings on GetLyricResponse.
        result = await self.client.lyric.get_lyric(int(identifier) if identifier.isdecimal() else identifier,
                                                   qrc=False, trans=True, roma=False)
        return {"lyric": str(result.lyric or "")[:131072], "translation": str(result.trans or "")[:131072]}

    async def dispatch(self, method, params):
        await self.init()
        if method == "search":
            keywords = str(params.get("keywords", "")).strip()
            if not keywords or len(keywords) > 200:
                raise ProviderError("input")
            return await self.search(keywords, count(params.get("limit"), 8))
        if method == "resolve":
            return song(await self.detail(str(params.get("id", ""))))
        if method == "playlist":
            return await self.import_playlist(str(params.get("id", "")), count(params.get("limit"), 100, 500))
        if method == "playlistDetails":
            return await self.playlist_page(str(params.get("id", "")), params.get("offset", 0), count(params.get("limit"), 50))
        if method == "discover":
            return await self.discover(params.get("category", "hot"))
        if method == "hot":
            charts = await self.discover("charts")
            chart = next((chart for chart in charts if "热歌" in chart["name"]), None)
            if not chart:
                raise ProviderError("unavailable")
            tracks = await self.import_playlist(chart["id"], count(params.get("limit"), 30, 500))
            return {"mode": "hot", "name": chart["name"], "tracks": tracks}
        if method == "account":
            return await self.account()
        if method == "qrCreate":
            return await self.qr_create(params.get("type", "qq"))
        if method == "qrStatus":
            return await self.qr_check()
        if method == "logout":
            async with self.lock:
                self.file.unlink(missing_ok=True)
                if self.qr_poll:
                    self.qr_poll.cancel()
                    self.qr_poll = None
                self.client.credential = Credential()
                self.qr = None
                self.qr_status = "none"
                self.expired = False
                self.bad_file = False
                self.verified_at = 0
            return {"ok": True}
        if method == "stream":
            return await self.stream(str(params.get("id", "")))
        if method == "lyrics":
            return await self.lyrics(str(params.get("id", "")))
        raise ProviderError("input")


def safe_error(error):
    if isinstance(error, ProviderError):
        return error.code
    name = type(error).__name__
    if "DeviceLimit" in name:
        return "login_device"
    if "AccountRestricted" in name:
        return "login_restricted"
    if "ratelimit" in name.lower():
        return "rate"
    if "Credential" in name or "AuthExpired" in name:
        return "login"
    return "upstream"


def error_diagnostic(error):
    name = type(error).__name__
    result = {"class": name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,79}", name) else "Error"}
    code = getattr(error, "code", None)
    if isinstance(code, int) and not isinstance(code, bool) and abs(code) <= 2147483647:
        result["code"] = code
    return result


async def main():
    directory = Path(sys.argv[sys.argv.index("--data-dir") + 1]).resolve()
    provider = Provider(directory)
    semaphore = asyncio.Semaphore(4)
    init_lock = asyncio.Lock()
    tasks = {}

    async def answer(request):
        identifier = request.get("id")
        try:
            if not SDK_READY:
                raise ProviderError("dependency")
            async with semaphore:
                async with init_lock:
                    await provider.init()
                result = await asyncio.wait_for(provider.dispatch(request.get("method"), request.get("params", {})), timeout=28)
            response = {"id": identifier, "ok": True, "result": result}
        except Exception as error:
            response = {"id": identifier, "ok": False, "error": safe_error(error), "diagnostic": error_diagnostic(error)}
        except asyncio.CancelledError:
            response = {"id": identifier, "ok": False, "error": "cancelled"}
        line = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
        if len(line.encode("utf-8")) > 2 * 1024 * 1024:
            line = json.dumps({"id": identifier, "ok": False, "error": "upstream"})
        RPC_OUT.write(line + "\n")
        RPC_OUT.flush()

    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.buffer.readline, 16385)
            if not line:
                break
            if len(line) > 16384 or not line.endswith(b"\n"):
                break
            try:
                request = json.loads(line)
                if not isinstance(request, dict) or not isinstance(request.get("params", {}), dict):
                    break
            except ValueError:
                break
            identifier = request.get("id")
            if not isinstance(identifier, int) or isinstance(identifier, bool) or identifier < 1:
                break
            if request.get("method") == "cancel":
                task = tasks.get(identifier)
                if task:
                    task.cancel()
                continue
            if len(tasks) >= 16:
                break
            if identifier in tasks:
                break
            task = asyncio.create_task(answer(request))
            tasks[identifier] = task
            task.add_done_callback(lambda finished, identifier=identifier: tasks.pop(identifier, None))
        if tasks:
            await asyncio.gather(*list(tasks.values()), return_exceptions=True)
    finally:
        if provider.qr_poll:
            provider.qr_poll.cancel()
            await asyncio.gather(provider.qr_poll, return_exceptions=True)
        if provider.client:
            await provider.client.__aexit__(None, None, None)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        sys.exit(1)
