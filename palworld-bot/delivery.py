"""Exactly-once *attempts*: persist IDs before sending, only query on ambiguity."""

from __future__ import annotations

import asyncio


class DefinitiveFailure(Exception):
    """The transport has proof that the server did not invoke inventory addition."""


class DeliveryCoordinator:
    def __init__(self, store, client, poll_interval=0.75, poll_attempts=20):
        self.store = store
        self.client = client
        self.poll_interval = poll_interval
        self.poll_attempts = max(1, int(poll_attempts))
        # The game endpoint accepts one request at a time. Serialize our claims.
        self._grant_lock = asyncio.Lock()

    def _accept(self, delivery, claim, receipt):
        if not isinstance(receipt, dict):
            return False
        expected = {"request_id": delivery["request_id"], "player_uid": claim["player_uid"],
                    "item_id": delivery["item_id"], "quantity": delivery["quantity"]}
        if any(receipt.get(key) != value for key, value in expected.items()):
            return False
        state = receipt.get("state")
        if state not in {"pending", "submitted", "failed", "unknown"}:
            return False
        self.store.set_delivery(delivery["request_id"], state, receipt.get("message", ""), receipt)
        return state

    async def _poll(self, delivery, claim):
        for attempt in range(self.poll_attempts):
            if attempt:
                await asyncio.sleep(self.poll_interval)
            try:
                receipt = await self.client.receipt(delivery["request_id"])
            except Exception:
                continue
            state = self._accept(delivery, claim, receipt)
            if state in {"submitted", "failed", "unknown"}:
                return state
        self.store.set_delivery(delivery["request_id"], "unknown", "发放结果尚不明确，保留次数并等待核对；不会重复发放。")
        return "unknown"

    async def grant(self, message_id, user_id, items, requested_text="", decision=None):
        async with self._grant_lock:
            existing = self.store.claim(message_id)
            if existing:
                if existing["user_id"] != str(user_id):
                    raise ValueError("Message ID belongs to another user")
                return await self._reconcile(existing)
            claim = self.store.begin_claim(message_id, user_id, items, requested_text, decision)
            if claim["state"] == "denied":
                return claim
            try:
                for delivery in claim["deliveries"]:
                    if not self.store.mark_sending(delivery["request_id"]):
                        # Another coordinator may own this request. Never POST twice.
                        return self.store.claim(message_id)
                    payload = {"request_id": delivery["request_id"], "player_uid": claim["player_uid"],
                               "item_id": delivery["item_id"], "quantity": delivery["quantity"]}
                    state = None
                    try:
                        receipt = await self.client.give(payload)
                        state = self._accept(delivery, claim, receipt)
                    except DefinitiveFailure as exc:
                        self.store.set_delivery(delivery["request_id"], "failed", str(exc))
                        state = "failed"
                    except Exception:
                        # Even a timeout/HTTP error may follow an inventory mutation.
                        pass
                    if state not in {"submitted", "failed", "unknown"}:
                        state = await self._poll(delivery, claim)
                    if state != "submitted":
                        self.store.skip_queued(message_id)
                        break
            except BaseException:
                # Cancellation leaves any attempted line reserved; unattempted lines
                # are explicitly cancelled and will never be replayed on restart.
                self.store.skip_queued(message_id)
                raise
            return self.store.claim(message_id)

    async def _reconcile(self, claim):
        for delivery in claim["deliveries"]:
            if delivery["state"] in {"sending", "pending", "unknown"}:
                await self._poll(delivery, claim)
        # Recovery is query-only. A crash cannot accidentally continue a partial recipe.
        return self.store.skip_queued(claim["message_id"], "原申请已中断，此项从未提交；不会自动补发。")

    async def reconcile(self, message_id):
        async with self._grant_lock:
            claim = self.store.claim(message_id)
            return await self._reconcile(claim) if claim else None

    async def reconcile_all(self):
        results = []
        for claim in self.store.unresolved_claims():
            results.append(await self.reconcile(claim["message_id"]))
        return results
