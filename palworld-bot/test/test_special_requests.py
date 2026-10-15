"""Explicit operator-approved medicines keep normal delivery safeguards."""
import asyncio
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bot import Bot
from catalog import Catalog, special_item_request
from delivery import DeliveryCoordinator
from policy import evaluate_request
from runtime import Runtime
from store import Store
from test_bot import FakeBridge, FakeGame, UID


SPECIALS = {
    "StatusPointResetSan": "消除记忆药",
    "PalGenderReverse": "帕鲁性转药",
}


class SpecialRequestParsingTests(unittest.TestCase):
    def test_explicit_aliases_default_to_one(self):
        aliases = {
            "StatusPointResetSan": ("消除记忆药", "洗点", "洗点药", "StatusPointResetSan"),
            "PalGenderReverse": ("帕鲁性转药", "性转药", "帕鲁变性药", "Pal Reverser", "PalGenderReverse"),
        }
        for item_id, names in aliases.items():
            for name in names:
                with self.subTest(name=name):
                    self.assertEqual(special_item_request("申请 " + name), {
                        "item_id": item_id, "quantity": 1, "defaulted": True,
                    })

    def test_quantity_before_and_after_name(self):
        for text, item_id, quantity in (
            ("申请 帕鲁性转药 2 瓶", "PalGenderReverse", 2),
            ("给我两瓶帕鲁性转药", "PalGenderReverse", 2),
            ("申请 消除记忆药 12 瓶", "StatusPointResetSan", 12),
            ("申请两瓶洗点药", "StatusPointResetSan", 2),
            ("申请 PalGenderReverse 3", "PalGenderReverse", 3),
            ("申请 StatusPointResetSan 3", "StatusPointResetSan", 3),
        ):
            with self.subTest(text=text):
                self.assertEqual(special_item_request(text), {
                    "item_id": item_id, "quantity": quantity, "defaulted": False,
                })

    def test_informational_negative_mixed_and_invalid_counts_do_not_auto_approve(self):
        for text in (
            "帕鲁性转药", "消除记忆药", "洗点", "PalGenderReverse",
            "帕鲁性转药是什么", "申请帕鲁性转药可以吗？", "不要申请帕鲁性转药",
            "申请帕鲁性转药和木头", "申请消除记忆药和帕鲁性转药",
            "申请帕鲁性转药0瓶", "申请帕鲁性转药-1瓶", "申请帕鲁性转药1.5瓶",
            "申请 PalGenderReverseExtra", "申请 MindControlDrug",
        ):
            with self.subTest(text=text):
                self.assertIsNone(special_item_request(text))


class SpecialRequestBotTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bot = Bot.__new__(Bot)
        self.bot.state = Path(self.tmp.name)
        self.bot.store = Store(self.bot.state / "claims.db")
        self.bot.runtime = Runtime(self.bot.state / "runtime.db")
        self.bot.bridge = FakeBridge()
        # These operator-approved consumables intentionally have no recipe,
        # known required level or medicine classification in the dataset.
        self.bot.catalog = Catalog({"schema_version": 1, "game_version": "1.2.3", "items": [
            {"id": item_id, "name": name, "category": "consumable", "required_level": None}
            for item_id, name in SPECIALS.items()
        ]})
        self.bot.game = FakeGame()
        self.bot.delivery = DeliveryCoordinator(self.bot.store, self.bot.game, poll_interval=0, poll_attempts=1)
        self.bot.model = type("UnavailableModel", (), {})()
        self.bot.model.decide = AsyncMock(side_effect=RuntimeError("model deliberately unavailable"))
        self.bot.wakeup, self.bot.stopping = asyncio.Event(), asyncio.Event()
        self.bot.sent = []

        async def send(text, quote=None, theme="info"):
            self.bot.sent.append({"text": text, "quote": quote, "theme": theme})
            return {"message_id": "fake_reply"}

        self.bot.send = send

    def tearDown(self):
        self.tmp.cleanup()

    def bind(self):
        self.bot.store.bind_verified("u1", UID, "steam_test", "测试玩家")

    @staticmethod
    def event(content, message_id="special1"):
        return {"author_id": "u1", "msg_id": message_id, "content": content}

    def assert_no_grant(self):
        self.assertEqual(self.bot.game.posts, [])
        self.bot.model.decide.assert_not_awaited()
        if self.bot.store.binding("u1"):
            self.assertEqual(self.bot.store.allowance("u1")["remaining"], 3)

    async def test_both_medicines_auto_approve_without_model_or_recipe(self):
        self.bind()
        for item_id, name in SPECIALS.items():
            await self.bot.handle(self.event("申请 " + name, item_id))
            self.assertEqual(self.bot.store.claim(item_id)["state"], "submitted")
        self.assertEqual([(p["item_id"], p["quantity"]) for p in self.bot.game.posts], [
            ("StatusPointResetSan", 1), ("PalGenderReverse", 1),
        ])
        self.bot.model.decide.assert_not_awaited()
        self.assertEqual(self.bot.store.allowance("u1")["used"], 2)

    async def test_explicit_quantity_is_delivered_unchanged(self):
        self.bind()
        await self.bot.handle(self.event("申请 帕鲁性转药 12 瓶"))
        self.assertEqual([(p["item_id"], p["quantity"]) for p in self.bot.game.posts], [("PalGenderReverse", 12)])
        self.bot.model.decide.assert_not_awaited()
        self.assertEqual(self.bot.store.allowance("u1")["used"], 1)

    async def test_duplicate_message_delivers_only_once(self):
        self.bind()
        event = self.event("申请 帕鲁性转药")
        await self.bot.handle(event)
        await self.bot.handle(event)
        self.assertEqual(len(self.bot.game.posts), 1)
        self.assertEqual(self.bot.store.allowance("u1")["used"], 1)
        self.bot.model.decide.assert_not_awaited()

    async def test_daily_allowance_still_limits_successful_claims_to_three(self):
        self.bind()
        for number in range(4):
            await self.bot.handle(self.event("申请 帕鲁性转药", f"special{number}"))
        self.assertEqual(len(self.bot.game.posts), 3)
        self.assertEqual(self.bot.store.allowance("u1")["used"], 3)
        self.assertEqual(self.bot.store.allowance("u1")["remaining"], 0)
        self.bot.model.decide.assert_not_awaited()

    async def test_unbound_user_cannot_receive_special_item(self):
        await self.bot.handle(self.event("申请 帕鲁性转药"))
        self.assert_no_grant()

    async def test_offline_bound_player_cannot_receive_special_item(self):
        self.bind()
        self.bot.bridge.value["players"] = []
        await self.bot.handle(self.event("申请 帕鲁性转药"))
        self.assert_no_grant()

    async def test_player_leaving_during_reply_is_rechecked_before_delivery(self):
        self.bind()
        send = self.bot.send

        async def send_and_disconnect(*args, **kwargs):
            result = await send(*args, **kwargs)
            self.bot.bridge.value["players"] = []
            return result

        self.bot.send = send_and_disconnect
        await self.bot.handle(self.event("申请 帕鲁性转药"))
        self.assert_no_grant()

    async def test_stale_world_does_not_approve_special_item(self):
        self.bind()
        self.bot.bridge.value["observed_at"] -= 600
        await self.bot.handle(self.event("申请 帕鲁性转药"))
        self.assert_no_grant()

    async def test_missing_catalog_entry_does_not_grant_or_deduct(self):
        self.bind()
        self.bot.catalog.items.pop("PalGenderReverse")
        await self.bot.handle(self.event("申请 帕鲁性转药"))
        self.assert_no_grant()

    async def test_disabled_catalog_entry_does_not_grant_or_deduct(self):
        self.bind()
        self.bot.catalog.items["PalGenderReverse"]["disabled"] = True
        await self.bot.handle(self.event("申请 帕鲁性转药"))
        self.assert_no_grant()

    def test_other_unknown_consumable_does_not_get_special_privilege(self):
        self.bot.catalog.items["TestOtherDrug"] = {
            "id": "TestOtherDrug", "name": "测试未知消耗品", "category": "consumable", "required_level": None,
        }
        world = self.bot.bridge.snapshot()
        world["player_level"] = 10
        plan = evaluate_request(self.bot.catalog, [{"item_id": "TestOtherDrug", "quantity": 1}], world)
        self.assertFalse(plan["approved"])
        self.assertEqual(plan["items"], [])


if __name__ == "__main__":
    unittest.main()
