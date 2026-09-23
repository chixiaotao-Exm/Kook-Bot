"""Focused bridge checks; run with the same Python environment as provider.py."""
import asyncio
import json
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import provider


class ProviderInitializationTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_or_cancelled_client_startup_is_cleaned_and_the_next_request_can_retry(self):
        for original_error in (RuntimeError("startup failure"), asyncio.CancelledError()):
            with self.subTest(error=type(original_error).__name__), tempfile.TemporaryDirectory(prefix="kook-qq-init-test-") as directory:
                created = []
                class Client:
                    def __init__(self, *args, **kwargs):
                        self.failed = not created
                        self.entered = 0
                        self.closed = 0
                        created.append(self)
                    async def __aenter__(self):
                        self.entered += 1
                        if self.failed:
                            raise original_error
                        return self
                    async def __aexit__(self, error_type, error, traceback):
                        self.closed += 1
                        if self.failed:
                            # Cleanup errors must not replace the startup error.
                            raise OSError("cleanup failure")
                service = provider.Provider(Path(directory))
                with patch.object(provider, "Client", Client, create=True), patch.object(provider, "Credential", return_value=object(), create=True):
                    with self.assertRaises(type(original_error)) as caught:
                        await service.init()
                    self.assertIs(caught.exception, original_error)
                    self.assertIsNone(service.client)
                    self.assertEqual(created[0].closed, 1)
                    await service.init()
                    self.assertIs(service.client, created[1])
                    await service.init()
                    self.assertEqual(len(created), 2)
                    self.assertEqual(created[1].entered, 1)


@unittest.skipUnless(provider.SDK_READY, "QQ SDK is not installed")
class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kook-qq-provider-test-")
        self.service = provider.Provider(Path(self.temp.name))

    async def asyncTearDown(self):
        if self.service.qr_poll:
            self.service.qr_poll.cancel()
            await asyncio.gather(self.service.qr_poll, return_exceptions=True)
        self.temp.cleanup()

    async def test_wechat_long_poll_does_not_block_status_or_credential_lock(self):
        gate = asyncio.Event()
        async def check(qrcode):
            await gate.wait()
            return SimpleNamespace(event=provider.QRCodeLoginEvents.CONF)
        self.service.client = SimpleNamespace(login=SimpleNamespace(check_qrcode=check))
        self.service.qr = object()
        self.service.qr_expires = int(provider.time.time() * 1000) + 180000
        self.service.qr_status = "waiting"
        self.assertEqual(await asyncio.wait_for(self.service.qr_check(), 0.1), {"status": "waiting"})
        await asyncio.sleep(0)
        self.assertFalse(self.service.qr_poll.done())
        await asyncio.wait_for(self.service.lock.acquire(), 0.1)
        self.service.lock.release()
        gate.set()
        await self.service.qr_poll
        self.assertEqual(await self.service.qr_check(), {"status": "scanned"})

    async def test_cancelled_old_qr_cannot_restore_login_after_logout(self):
        gate = asyncio.Event()
        credential = provider.Credential(musicid=123, musickey="test-key")
        async def check(qrcode):
            await gate.wait()
            return SimpleNamespace(event=provider.QRCodeLoginEvents.DONE, credential=credential)
        self.service.client = SimpleNamespace(login=SimpleNamespace(check_qrcode=check), credential=credential)
        self.service.qr = object()
        self.service.qr_expires = int(provider.time.time() * 1000) + 180000
        self.service.qr_status = "waiting"
        await self.service.qr_check()
        old_poll = self.service.qr_poll
        await self.service.dispatch("logout", {})
        gate.set()
        await asyncio.gather(old_poll, return_exceptions=True)
        self.assertEqual(self.service.client.credential.musicid, 0)
        self.assertFalse(self.service.file.exists())
        self.assertEqual(await self.service.qr_check(), {"status": "none"})

    async def test_credential_roundtrip_keeps_refresh_fields_private(self):
        self.service.client = SimpleNamespace(credential=provider.Credential())
        credential = provider.Credential(musicid=123, musickey="test-key", refresh_key="refresh-key",
                                         refresh_token="refresh-token", musickeyCreateTime=1234, keyExpiresIn=600)
        self.service.save_credential(credential)
        restored = provider.Credential.model_validate_json(self.service.file.read_text(encoding="utf-8"))
        self.assertEqual(restored.refresh_key, "refresh-key")
        self.assertEqual(restored.musickey_create_time, 1234)
        status = await self.service.account()
        self.assertTrue(status["loggedIn"])
        self.assertNotIn("test-key", json.dumps(status))
        self.assertNotIn("refresh", json.dumps(status))

    async def test_playlist_arbitrary_page_crossing_preserves_order(self):
        calls = []
        def track(identifier):
            return {"id": identifier, "mid": "0039MnYb0qxYhV", "name": str(identifier), "singer": [], "interval": 1}
        async def get_detail(identifier, num, page):
            calls.append((identifier, num, page))
            return SimpleNamespace(info={"id": identifier, "title": "Songs"}, total=123,
                                   songs=[track(i) for i in range((page - 1) * num + 1, min(page * num, 123) + 1)])
        self.service.client = SimpleNamespace(songlist=SimpleNamespace(get_detail=get_detail))
        result = await self.service.playlist_page("456", 95, 10)
        self.assertEqual([item["id"] for item in result["tracks"]], [str(i) for i in range(96, 106)])
        self.assertEqual(calls, [(456, 100, 1), (456, 100, 2)])
        self.assertEqual(result["total"], 123)
        self.assertTrue(result["hasMore"])

    async def test_missing_or_expired_credentials_stop_before_detail_and_vkey(self):
        calls = []
        async def detail(identifier):
            calls.append("detail")
            raise AssertionError("must not request song details without login")
        async def vkey(*args, **kwargs):
            calls.append("vkey")
            raise AssertionError("must not request VKey without login")
        self.service.detail = detail
        self.service.client = SimpleNamespace(credential=provider.Credential(), song=SimpleNamespace(get_song_urls=vkey))
        with self.assertRaises(provider.ProviderError) as missing:
            await self.service.stream("123")
        self.assertEqual(missing.exception.code, "login")
        self.service.client.credential = provider.Credential(musicid=123, musickey="expired-key")
        self.service.expired = True
        self.service.verified_at = provider.time.monotonic()
        with self.assertRaises(provider.ProviderError) as expired:
            await self.service.stream("123")
        self.assertEqual(expired.exception.code, "login")
        await self.service.dispatch("logout", {})
        with self.assertRaises(provider.ProviderError) as logged_out:
            await self.service.stream("123")
        self.assertEqual(logged_out.exception.code, "login")
        self.assertEqual(calls, [])

    async def test_error_diagnostics_never_include_messages_or_raw_responses(self):
        class CgiApiException(Exception):
            code = 104009
            data = {"cookie": "secret", "url": "https://example.invalid/token"}
        error = CgiApiException("secret credential and signed URL")
        self.assertEqual(provider.error_diagnostic(error), {"class": "CgiApiException", "code": 104009})
        error.code = "secret"
        self.assertEqual(provider.error_diagnostic(error), {"class": "CgiApiException"})

    async def test_rate_limited_sdk_exception_spelling_is_recognized(self):
        class RatelimitedError(Exception):
            code = 2001
        class LoginRateLimitError(Exception):
            code = 104604
        for error in (RatelimitedError("private upstream details"), LoginRateLimitError("private")):
            self.assertEqual(provider.safe_error(error), "rate")
            self.assertNotIn("private", json.dumps(provider.error_diagnostic(error)))

    async def test_lyrics_use_sdk_mid_or_integer_and_decoded_lrc_fields(self):
        calls = []
        async def get_lyric(identifier, **options):
            calls.append((identifier, options))
            return SimpleNamespace(lyric="[00:01]hello", trans="[00:01]你好")
        self.service.client = SimpleNamespace(lyric=SimpleNamespace(get_lyric=get_lyric))
        result = await self.service.dispatch("lyrics", {"id": "0039MnYb0qxYhV"})
        self.assertEqual(result, {"lyric": "[00:01]hello", "translation": "[00:01]你好"})
        await self.service.dispatch("lyrics", {"id": "123"})
        self.assertEqual(calls, [("0039MnYb0qxYhV", {"qrc": False, "trans": True, "roma": False}),
                                 (123, {"qrc": False, "trans": True, "roma": False})])
        with self.assertRaises(provider.ProviderError):
            await self.service.dispatch("lyrics", {"id": "invalid"})
        self.assertEqual(len(calls), 2)

    async def test_rpc_cancel_preserves_other_tasks_and_process(self):
        script = '''
import asyncio
import provider
class Fake:
    qr_poll = None
    client = None
    def __init__(self, directory): pass
    async def init(self): pass
    async def dispatch(self, method, params):
        await asyncio.sleep(10 if method == 'slow' else 0.03)
        return method
provider.Provider = Fake
provider.SDK_READY = True
asyncio.run(provider.main())
'''
        child = await asyncio.create_subprocess_exec(sys.executable, "-u", "-c", script, "--data-dir", self.temp.name,
                    cwd=str(Path(provider.__file__).parent), stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        async def send(identifier, method):
            child.stdin.write((json.dumps({"id": identifier, "method": method, "params": {}}) + "\n").encode())
            await child.stdin.drain()
        try:
            await send(1, "slow")
            await send(2, "quick")
            await asyncio.sleep(0.1)
            await send(1, "cancel")
            replies = [json.loads(await asyncio.wait_for(child.stdout.readline(), 15)) for _ in range(2)]
            indexed = {reply["id"]: reply for reply in replies}
            self.assertEqual(indexed[1]["error"], "cancelled")
            self.assertEqual(indexed[2]["result"], "quick")
            await send(3, "still_alive")
            self.assertEqual(json.loads(await asyncio.wait_for(child.stdout.readline(), 2))["result"], "still_alive")
            child.stdin.close()
            self.assertEqual(await asyncio.wait_for(child.wait(), 5), 0)
        finally:
            if child.returncode is None:
                child.kill()
                await child.wait()


if __name__ == "__main__":
    unittest.main()
