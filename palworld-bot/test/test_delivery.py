import asyncio
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delivery import DeliveryCoordinator, DefinitiveFailure
from store import Store


UID = "A" * 32
ITEMS = [{"item_id": "Wood", "quantity": 10}]


class FakeClient:
    def __init__(self, give_state="submitted", poll_state="submitted", throw=False):
        self.give_state, self.poll_state, self.throw = give_state, poll_state, throw
        self.posts, self.gets, self.requests = [], [], {}

    async def give(self, payload):
        self.posts.append(dict(payload))
        self.requests[payload["request_id"]] = dict(payload)
        if self.throw:
            raise TimeoutError("response was lost after server applied item")
        return {**payload, "state": self.give_state, "message": "inventory invocation returned"}

    async def receipt(self, request_id):
        self.gets.append(request_id)
        if self.poll_state is None:
            raise TimeoutError("receipt unavailable")
        return {**self.requests[request_id], "state": self.poll_state, "message": "receipt"}


class DeliveryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "store.db")
        self.store.bind_verified("u1", UID, "steam_1", "玩家")

    def tearDown(self):
        self.tmp.cleanup()

    def coordinator(self, client):
        return DeliveryCoordinator(self.store, client, poll_interval=0, poll_attempts=2)

    async def test_success_and_replayed_message_only_one_post(self):
        client = FakeClient()
        coordinator = self.coordinator(client)
        results = await asyncio.gather(*[coordinator.grant("m1", "u1", ITEMS) for _ in range(8)])
        self.assertTrue(all(c["state"] == "submitted" for c in results))
        self.assertEqual(len(client.posts), 1)
        self.assertEqual(self.store.allowance("u1")["used"], 1)

    async def test_lost_post_response_queries_same_id(self):
        client = FakeClient(throw=True)
        result = await self.coordinator(client).grant("m1", "u1", ITEMS)
        self.assertEqual(result["state"], "submitted")
        self.assertEqual(len(client.posts), 1)
        self.assertEqual(client.gets, [client.posts[0]["request_id"]])

    async def test_unavailable_receipt_holds_allowance_across_restart(self):
        client = FakeClient(throw=True, poll_state=None)
        result = await self.coordinator(client).grant("m1", "u1", ITEMS)
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["allowance"]["reserved"], 1)
        self.store = Store(self.store.path)
        await self.coordinator(client).grant("m1", "u1", ITEMS)
        self.assertEqual(len(client.posts), 1)
        client.poll_state = "submitted"
        result = await self.coordinator(client).reconcile("m1")
        self.assertEqual(result["allowance"]["used"], 1)
        self.assertEqual(result["allowance"]["reserved"], 0)

    async def test_failed_receipt_refunds_and_stops_remaining_ingredients(self):
        client = FakeClient(give_state="failed")
        result = await self.coordinator(client).grant("m1", "u1", ITEMS + [{"item_id": "Stone", "quantity": 5}])
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["allowance"]["remaining"], 3)
        self.assertEqual(len(client.posts), 1)
        self.assertEqual(result["deliveries"][1]["state"], "skipped")

    async def test_partial_success_consumes_one_and_no_replay(self):
        client = FakeClient()
        original_give = client.give
        async def second_failure(payload):
            client.give_state = "submitted" if not client.posts else "failed"
            return await original_give(payload)
        client.give = second_failure
        coordinator = self.coordinator(client)
        result = await coordinator.grant("m1", "u1", ITEMS + [{"item_id": "Stone", "quantity": 5}])
        self.assertEqual(result["state"], "partial")
        self.assertEqual(result["allowance"]["used"], 1)
        await coordinator.grant("m1", "u1", ITEMS)
        self.assertEqual(len(client.posts), 2)

    async def test_crash_before_post_does_not_guess_or_resubmit(self):
        claim = self.store.begin_claim("m1", "u1", ITEMS)
        self.store.mark_sending(claim["deliveries"][0]["request_id"])
        client = FakeClient(poll_state=None)
        result = await self.coordinator(client).reconcile("m1")
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(client.posts, [])

    async def test_crash_before_any_attempt_releases_reservation(self):
        self.store.begin_claim("m1", "u1", ITEMS)
        result = await self.coordinator(FakeClient()).reconcile("m1")
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["allowance"]["remaining"], 3)

    async def test_wrong_receipt_cannot_claim_success(self):
        client = FakeClient()
        async def wrong(payload):
            client.posts.append(payload)
            return {**payload, "player_uid": "B" * 32, "state": "submitted"}
        client.give = wrong
        result = await self.coordinator(client).grant("m1", "u1", ITEMS)
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["allowance"]["used"], 0)

    async def test_explicit_pre_execution_rejection_does_not_count(self):
        client = FakeClient()
        async def reject(payload):
            client.posts.append(payload)
            raise DefinitiveFailure("目标玩家离线，没有执行发放")
        client.give = reject
        result = await self.coordinator(client).grant("m1", "u1", ITEMS)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["allowance"]["remaining"], 3)
        self.assertEqual(client.gets, [])

    async def test_cancellation_reconciles_without_second_post(self):
        client = FakeClient()
        started = asyncio.Event()
        async def hang(payload):
            client.posts.append(payload)
            client.requests[payload["request_id"]] = payload
            started.set()
            await asyncio.Future()
        client.give = hang
        coordinator = self.coordinator(client)
        task = asyncio.create_task(coordinator.grant("m1", "u1", ITEMS + [{"item_id": "Stone", "quantity": 5}]))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.store.claim("m1")["deliveries"][1]["state"], "skipped")
        result = await self.coordinator(client).reconcile("m1")
        self.assertEqual(result["state"], "partial")
        self.assertEqual(len(client.posts), 1)


if __name__ == "__main__":
    unittest.main()
