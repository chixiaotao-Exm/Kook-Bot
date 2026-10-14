"""End-to-end bot orchestration using synthetic game facts and no network."""
import asyncio
import copy
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bot import Bot
from catalog import Catalog
from delivery import DefinitiveFailure, DeliveryCoordinator
from runtime import Runtime
from store import Store
from transport import GameClient, HTTPError


UID = "A" * 32


class FakeBridge:
    def __init__(self):
        self.value = {
            "observed_at": time.time(), "world_level": 10, "world_day": 2, "base_count": 1,
            "source": "synthetic_test", "game_version": "1.2.3.456", "server_version": "1.2.3.456",
            "capabilities": {"binding": True},
            "players": [{"name": "测试玩家", "player_uid": UID, "account_id": "steam_test", "level": 10}],
        }

    def snapshot(self):
        return copy.deepcopy(self.value)


class FakeModel:
    def __init__(self):
        self.calls = []
        self.result = {"intent": "request", "approved": True,
                       "items": [{"item_id": "TestLog", "quantity": 10}],
                       "reason": "允许普通补给", "reply": ""}

    async def decide(self, text, world, candidates):
        self.calls.append({"text": text, "world": copy.deepcopy(world), "candidates": candidates})
        return copy.deepcopy(self.result)


class FakeGame:
    def __init__(self):
        self.posts = []

    async def give(self, payload):
        self.posts.append(dict(payload))
        return {**payload, "state": "submitted", "message": "Synthetic inventory call returned"}

    async def receipt(self, request_id):
        payload = next(p for p in self.posts if p["request_id"] == request_id)
        return {**payload, "state": "submitted"}


class BotTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bot = Bot.__new__(Bot)
        self.bot.state = Path(self.tmp.name)
        self.bot.store = Store(self.bot.state / "claims.db")
        self.bot.runtime = Runtime(self.bot.state / "runtime.db")
        self.bot.bridge = FakeBridge()
        # Invented catalogue/recipe intentionally carries no game data.
        self.bot.catalog = Catalog({"schema_version": 1, "game_version": "1.2.3", "items": [
            {"id": "TestLog", "name": "测试原料", "category": "material", "direct_basic": True, "required_level": 1},
            {"id": "TestRock", "name": "测试石料", "category": "material", "direct_basic": True, "required_level": 1},
            {"id": "TestTool", "name": "测试工具", "category": "weapon", "required_level": 5,
             "recipe": {"output_quantity": 1, "source": "synthetic_fixture", "ingredients": [
                 {"item_id": "TestLog", "quantity": 4}, {"item_id": "TestRock", "quantity": 2}]}},
        ]})
        self.bot.game = FakeGame()
        self.bot.delivery = DeliveryCoordinator(self.bot.store, self.bot.game, poll_interval=0, poll_attempts=1)
        self.bot.model = FakeModel()
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
    def event(content="申请测试原料 10 个", msg_id="m1", author_id="u1"):
        return {"author_id": author_id, "msg_id": msg_id, "content": content}

    async def test_material_request_reaches_durable_ledger_and_game(self):
        self.bind()
        await self.bot.handle(self.event())
        self.assertEqual(len(self.bot.game.posts), 1)
        self.assertEqual(self.bot.game.posts[0]["player_uid"], UID)
        self.assertEqual(self.bot.game.posts[0]["item_id"], "TestLog")
        self.assertEqual(self.bot.game.posts[0]["quantity"], 10)
        self.assertEqual(self.bot.store.claim("m1")["state"], "submitted")
        self.assertEqual(self.bot.store.allowance("u1")["used"], 1)
        self.assertIn("核对游戏背包", self.bot.sent[-1]["text"])

    async def test_crafted_request_sends_finished_item_once(self):
        self.bind()
        self.bot.model.result["items"] = [{"item_id": "TestTool", "quantity": 1}]
        await self.bot.handle(self.event("申请测试工具 1 把"))
        self.assertEqual({p["item_id"]: p["quantity"] for p in self.bot.game.posts}, {"TestTool": 1})
        self.assertEqual(self.bot.store.allowance("u1")["used"], 1)
        self.assertNotIn("折算为材料", self.bot.sent[-1]["text"])

    async def test_memory_reset_alias_auto_grants_one_bottle(self):
        self.bind()
        self.bot.catalog.items['MindControlDrug'] = {'id': 'MindControlDrug', 'name': '洗脑药', 'category': 'medicine', 'required_level': 42,
            'recipe': {'output_quantity': 1, 'source': 'synthetic', 'ingredients': [{'item_id': 'TestRock', 'quantity': 1}]}}
        self.bot.model.result['items'] = [{'item_id': 'MindControlDrug', 'quantity': 1}]
        await self.bot.handle(self.event('申请 洗点'))
        self.assertEqual([(p['item_id'], p['quantity']) for p in self.bot.game.posts], [('MindControlDrug', 1)])

    async def test_unbound_user_cannot_call_model_or_grant(self):
        await self.bot.handle(self.event())
        self.assertEqual(self.bot.model.calls, [])
        self.assertEqual(self.bot.game.posts, [])
        self.assertIn("绑定", self.bot.sent[-1]["text"])

    async def test_stale_world_never_reaches_inventory(self):
        self.bind()
        self.bot.bridge.value["observed_at"] -= 600
        await self.bot.handle(self.event())
        self.assertEqual(self.bot.game.posts, [])
        self.assertEqual(self.bot.store.claim("m1")["state"], "denied")
        self.assertEqual(self.bot.store.allowance("u1")["remaining"], 3)

    async def test_duplicate_message_does_not_rerun_model_or_grant(self):
        self.bind()
        await self.bot.handle(self.event())
        await self.bot.handle(self.event())
        self.assertEqual(len(self.bot.model.calls), 1)
        self.assertEqual(len(self.bot.game.posts), 1)
        self.assertEqual(self.bot.store.allowance("u1")["used"], 1)

    async def test_model_approval_cannot_override_quantity_policy(self):
        self.bind()
        self.bot.model.result["items"][0]["quantity"] = 10000
        await self.bot.handle(self.event("申请测试原料 10000 个"))
        self.assertEqual(self.bot.game.posts, [])
        self.assertEqual(self.bot.store.allowance("u1")["remaining"], 3)
        self.assertIn("最多", self.bot.sent[-1]["text"])

    async def test_model_denial_does_not_consume_allowance(self):
        self.bind()
        self.bot.model.result.update(approved=False, reason="不适合当前阶段")
        await self.bot.handle(self.event())
        self.assertEqual(self.bot.game.posts, [])
        self.assertEqual(self.bot.store.claim("m1")["state"], "denied")
        self.assertEqual(self.bot.store.allowance("u1")["remaining"], 3)

    async def test_recheck_online_player_after_model(self):
        self.bind()
        original = self.bot.model.decide
        async def leaves_during_model(*args):
            result = await original(*args)
            self.bot.bridge.value["players"] = []
            return result
        self.bot.model.decide = leaves_during_model
        await self.bot.handle(self.event())
        self.assertEqual(self.bot.game.posts, [])
        self.assertEqual(self.bot.store.allowance("u1")["remaining"], 3)
        self.assertIn("离线", self.bot.sent[-1]["text"])

    async def test_binding_challenge_rejects_other_player_uid(self):
        code = self.bot.runtime.challenge("u1", UID, "binding_message")
        await self.bot.process_game_event({"type": "binding", "code": code, "player_uid": "B" * 32})
        self.assertIsNone(self.bot.store.binding("u1"))
        self.assertIsNotNone(self.bot.runtime.proof(code, UID))
        await self.bot.process_game_event({"type": "binding", "code": code, "player_uid": UID})
        self.assertEqual(self.bot.store.binding("u1")["account_id"], "steam_test")
        self.assertIsNone(self.bot.runtime.proof(code, UID))

    async def test_expired_challenge_cannot_bind(self):
        self.bot.runtime.now = lambda: 1
        code = self.bot.runtime.challenge("u1", UID, "binding_message")
        self.bot.runtime.now = lambda: 602
        await self.bot.process_game_event({"type": "binding", "code": code, "player_uid": UID})
        self.assertIsNone(self.bot.store.binding("u1"))

    async def test_background_failure_terminates_service_for_restart(self):
        cancelled = []
        async def fail():
            raise RuntimeError("synthetic_db_failure")
        async def block():
            try:
                await asyncio.Future()
            finally:
                cancelled.append(True)
        self.bot.input_loop = block
        self.bot.work_loop = fail
        self.bot.poll_loop = block
        self.bot.reconcile_loop = block
        with self.assertRaisesRegex(RuntimeError, "synthetic_db_failure"):
            await asyncio.wait_for(self.bot.run(), timeout=1)
        self.assertEqual(len(cancelled), 3)

    async def test_worker_cancellation_preserves_inbox_for_restart(self):
        started = asyncio.Event()
        async def handle(event):
            started.set()
            await asyncio.Future()
        self.bot.handle = handle
        self.bot.runtime.enqueue(self.event())
        task = asyncio.create_task(self.bot.work_loop())
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        restarted = Runtime(self.bot.state / "runtime.db")
        self.assertEqual(restarted.next()["msg_id"], "m1")

    async def test_definitive_http_rejections_refund_but_5xx_stays_ambiguous(self):
        self.bind()
        client = GameClient("http://127.0.0.1:1", "synthetic_token")
        for status in (401, 403, 422):
            client.request = AsyncMock(side_effect=HTTPError(status))
            coordinator = DeliveryCoordinator(self.bot.store, client, poll_interval=0, poll_attempts=1)
            result = await coordinator.grant(str(status), "u1", [{"item_id": "TestLog", "quantity": 1}])
            self.assertEqual(result["state"], "failed")
            self.assertEqual(result["allowance"]["remaining"], 3)
            self.assertEqual(client.request.await_count, 1)
        client.request = AsyncMock(side_effect=HTTPError(500))
        with self.assertRaises(HTTPError):
            await client.give({})

    def foods(self):
        self.bot.catalog.items.update({
            'TestMeal': {'id': 'TestMeal', 'name': '测试熟果', 'category': 'food', 'required_level': 2},
            'TestBerry': {'id': 'TestBerry', 'name': '测试野果', 'category': 'ingredient', 'required_level': 1},
            'TestFutureMeal': {'id': 'TestFutureMeal', 'name': '测试高阶食品', 'category': 'food', 'required_level': 50},
        })
        preference = patch('catalog.DEFAULT_FOOD_IDS', ('TestMeal', 'TestBerry', 'TestFutureMeal'))
        preference.start()
        self.addCleanup(preference.stop)
        self.bot.model.result['items'] = [{'item_id': 'TestMeal', 'quantity': 10}]

    async def test_generic_food_request_selects_one_real_food_and_keeps_quantity(self):
        self.bind()
        self.foods()
        await self.bot.handle(self.event('申请食物10份'))
        self.assertEqual([(p['item_id'], p['quantity']) for p in self.bot.game.posts], [('TestMeal', 10)])
        candidates = self.bot.model.calls[0]['candidates']
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]['assistance_selection']['quantity'], 10)
        self.assertIn('测试熟果 × 10', self.bot.sent[0]['text'])
        self.assertEqual(self.bot.store.allowance('u1')['used'], 1)

    async def test_food_recommendation_and_hunger_never_deliver(self):
        self.bind()
        self.foods()
        for index, content in enumerate(('我饿了', '有什么食物', '推荐吃什么')):
            await self.bot.handle(self.event(content, 'browse' + str(index)))
            self.assertIn('测试熟果', self.bot.sent[-1]['text'])
            self.assertIn('测试野果', self.bot.sent[-1]['text'])
            self.assertNotIn('测试高阶食品', self.bot.sent[-1]['text'])
        await self.bot.handle(self.event('10份', 'number'))
        self.assertEqual(self.bot.game.posts, [])
        self.assertEqual(self.bot.model.calls, [])

    async def test_missing_quantity_continues_only_for_same_bound_user_and_channel(self):
        self.bind()
        self.foods()
        await self.bot.handle({**self.event('申请食物'), 'target_id': 'food-channel'})
        self.assertIn('10份', self.bot.sent[-1]['text'])
        self.assertEqual(self.bot.game.posts, [])
        await self.bot.handle({**self.event('10份', 'other-channel'), 'target_id': 'elsewhere'})
        self.assertEqual(self.bot.game.posts, [])
        await self.bot.handle({**self.event('10份', 'same-channel'), 'target_id': 'food-channel'})
        self.assertEqual(len(self.bot.game.posts), 1)
        self.assertIn('此前明确申请', self.bot.model.calls[-1]['text'])
        await self.bot.handle({**self.event('10份', 'duplicate-number'), 'target_id': 'food-channel'})
        self.assertEqual(len(self.bot.game.posts), 1)

    async def test_expired_food_context_and_new_topic_do_not_deliver(self):
        self.bind()
        self.foods()
        await self.bot.handle(self.event('申请食物'))
        key = self.bot.food_key(self.event())
        pending = self.bot.runtime.get(key)
        pending['expires_at'] = 1
        self.bot.runtime.put(key, pending)
        await self.bot.handle(self.event('10份', 'expired'))
        self.assertEqual(self.bot.game.posts, [])
        await self.bot.handle(self.event('申请食物', 'new-food'))
        self.bot.model.result = {'intent': 'chat', 'approved': False, 'items': [], 'reason': '', 'reply': '好'}
        await self.bot.handle(self.event('不要食物了', 'cancel'))
        await self.bot.handle(self.event('10份', 'after-cancel'))
        self.assertEqual(self.bot.game.posts, [])

    async def test_change_food_only_updates_recommendation_and_never_regrants(self):
        self.bind()
        self.foods()
        await self.bot.handle(self.event('申请食物'))
        await self.bot.handle(self.event('换一个', 'change'))
        self.assertIn('推荐：测试野果', self.bot.sent[-1]['text'])
        self.assertEqual(self.bot.game.posts, [])
        self.bot.model.result['items'] = [{'item_id': 'TestBerry', 'quantity': 10}]
        await self.bot.handle(self.event('10份', 'claim'))
        self.assertEqual(self.bot.game.posts[0]['item_id'], 'TestBerry')
        await self.bot.handle(self.event('换一个', 'after-claim'))
        self.assertIn('不会再次发放', self.bot.sent[-1]['text'])
        await self.bot.handle(self.event('10份', 'after-number'))
        self.assertEqual(len(self.bot.game.posts), 1)

    async def test_generic_food_selection_cannot_be_expanded_by_model(self):
        self.bind()
        self.foods()
        self.bot.model.result['items'] += [{'item_id': 'TestBerry', 'quantity': 10}]
        await self.bot.handle(self.event('申请食物10份'))
        self.assertEqual(self.bot.game.posts, [])
        self.assertEqual(self.bot.store.allowance('u1')['remaining'], 3)

    async def test_no_food_data_and_stale_world_never_ask_user_for_catalogue(self):
        self.bind()
        await self.bot.handle(self.event('申请食物10份'))
        self.assertIn('机器人的普通食品资料', self.bot.sent[-1]['text'])
        self.assertNotIn('请提供', self.bot.sent[-1]['text'])
        self.foods()
        self.bot.bridge.value['observed_at'] -= 600
        await self.bot.handle(self.event('申请食物10份', 'stale'))
        self.assertEqual(self.bot.game.posts, [])
        self.assertEqual(self.bot.model.calls, [])

    async def test_stage_one_food_uses_eligible_basic_ingredient(self):
        self.bind()
        self.foods()
        self.bot.bridge.value['players'][0]['level'] = 1
        self.bot.model.result['items'] = [{'item_id': 'TestBerry', 'quantity': 10}]
        await self.bot.handle(self.event('申请食物10份'))
        self.assertEqual(self.bot.game.posts[0]['item_id'], 'TestBerry')

    async def test_generic_food_rechecks_progression_after_model(self):
        self.bind()
        self.foods()
        original = self.bot.model.decide
        async def becomes_stale(*args):
            result = await original(*args)
            self.bot.bridge.value['observed_at'] -= 600
            return result
        self.bot.model.decide = becomes_stale
        await self.bot.handle(self.event('申请食物10份'))
        self.assertEqual(self.bot.game.posts, [])
        self.assertEqual(self.bot.store.allowance('u1')['remaining'], 3)


if __name__ == "__main__":
    unittest.main()
