import concurrent.futures
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from store import BindingConflict, Store


UID = "A" * 32
ITEMS = [{"item_id": "Wood", "quantity": 10}]


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.now = datetime(2026, 10, 13, 15, 59, 0, tzinfo=timezone.utc).timestamp()
        self.path = Path(self.tmp.name) / "store.db"
        self.store = Store(self.path, now=lambda: self.now)
        self.store.bind_verified("u1", UID, "steam_1", "玩家")

    def tearDown(self):
        self.tmp.cleanup()

    def finish(self, claim, state="submitted"):
        line = claim["deliveries"][0]
        self.store.mark_sending(line["request_id"])
        return self.store.set_delivery(line["request_id"], state)

    def test_binding_unique_account_and_uid(self):
        for uid, account in [(UID, "steam_2"), ("B" * 32, "steam_1")]:
            with self.assertRaises(BindingConflict):
                self.store.bind_verified("u2", uid, account)
        with self.assertRaises(BindingConflict):
            self.store.bind_verified("u1", "B" * 32, "steam_2")
        # A recreated game character keeps account allowance.
        self.finish(self.store.begin_claim("m1", "u1", ITEMS))
        self.store.bind_verified("u1", "B" * 32, "steam_1")
        self.assertEqual(self.store.allowance("u1")["used"], 1)

    def test_success_three_and_beijing_midnight(self):
        for index in range(3):
            self.finish(self.store.begin_claim(str(index), "u1", ITEMS))
        self.assertEqual(self.store.begin_claim("4", "u1", ITEMS)["state"], "denied")
        self.now += 120
        self.assertEqual(self.store.allowance("u1")["remaining"], 3)
        self.assertEqual(self.store.allowance("u1")["day"], "2026-10-14")

    def test_denied_failed_do_not_count_unknown_reserves(self):
        self.store.record_denial("denied", "u1", "不符合当前世界进度")
        self.finish(self.store.begin_claim("failed", "u1", ITEMS), "failed")
        self.assertEqual(self.store.allowance("u1")["remaining"], 3)
        unknown = self.finish(self.store.begin_claim("unknown", "u1", ITEMS), "unknown")
        self.assertEqual(unknown["allowance"]["reserved"], 1)
        self.assertEqual(unknown["allowance"]["remaining"], 2)
        # Definitive late failure refunds; no new request is created.
        self.store.set_delivery(unknown["deliveries"][0]["request_id"], "failed")
        self.assertEqual(self.store.allowance("u1")["remaining"], 3)

    def test_partial_ingredients_count_once(self):
        claim = self.store.begin_claim("multi", "u1", ITEMS + [{"item_id": "Stone", "quantity": 5}])
        self.finish(claim)
        self.store.skip_queued("multi")
        result = self.store.claim("multi")
        self.assertEqual(result["state"], "partial")
        self.assertEqual(result["allowance"]["used"], 1)
        self.assertEqual(result["allowance"]["reserved"], 0)

    def test_message_id_and_receipts_survive_restart(self):
        original = self.store.begin_claim("m1", "u1", ITEMS)
        restarted = Store(self.path, now=lambda: self.now)
        duplicate = restarted.begin_claim("m1", "u1", [{"item_id": "Stone", "quantity": 999}])
        self.assertEqual(original["deliveries"], duplicate["deliveries"])
        self.assertEqual(duplicate["allowance"]["reserved"], 1)
        with self.assertRaises(ValueError):
            restarted.begin_claim("m1", "u2", ITEMS)

    def test_parallel_claims_reserve_atomically(self):
        def reserve(index):
            return Store(self.path, now=lambda: self.now).begin_claim(str(index), "u1", ITEMS)["state"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            states = list(pool.map(reserve, range(12)))
        self.assertEqual(states.count("reserved"), 3)
        self.assertEqual(states.count("denied"), 9)

    def test_stale_poll_cannot_downgrade_success(self):
        claim = self.finish(self.store.begin_claim("m1", "u1", ITEMS))
        self.store.set_delivery(claim["deliveries"][0]["request_id"], "unknown")
        self.assertEqual(self.store.claim("m1")["state"], "submitted")

    def test_duplicate_ingredients_combined_and_invalid_rejected(self):
        claim = self.store.begin_claim("combined", "u1", ITEMS + ITEMS)
        self.assertEqual(len(claim["deliveries"]), 1)
        self.assertEqual(claim["deliveries"][0]["quantity"], 20)
        for quantity in [0, -1, True, 1.5, 2147483648]:
            with self.assertRaises(ValueError):
                self.store.begin_claim("bad", "u1", [{"item_id": "Wood", "quantity": quantity}])


if __name__ == "__main__":
    unittest.main()
