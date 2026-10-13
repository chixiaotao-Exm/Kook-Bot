"""Deterministic item assistance rules beneath the language model's decision."""
from __future__ import annotations

import math
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime

from catalog import Catalog, EXCLUDED_CATEGORIES


@dataclass(frozen=True)
class PolicyLimits:
    max_request_lines: int = 8
    max_material_quantity: int = 100
    max_food_quantity: int = 20
    max_medicine_quantity: int = 5
    max_crafted_quantity: int = 1  # Number of complete recipe batches.
    max_delivery_lines: int = 24
    max_delivery_quantity: int = 1000
    world_max_age_seconds: int = 180


def _denied(code, message, evidence=None):
    return {"approved": False, "code": code, "reason": message, "items": [], "conversions": [], "evidence": evidence or {}}


def _timestamp(value):
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.timestamp() if parsed.tzinfo else None
        except ValueError:
            return None
    return float(value) if type(value) in (int, float) and math.isfinite(value) else None


def _level(value):
    return value if type(value) is int and 1 <= value <= 100 else None


def _gate(item, world, effective_level):
    label = item["name"]
    if item.get("disabled") or item.get("category") in EXCLUDED_CATEGORIES:
        return f"{label} 不属于可申请的普通补给物品。"
    if item.get("ambiguous_progression"):
        return f"{label} 的解锁条件存在多个数据分支，暂不自动发放。"
    needed = _level(item.get("required_level"))
    if needed is None:
        return f"还没有 {label} 的可靠进度条件，暂不自动发放。"
    if effective_level < needed:
        return f"{label} 对应的资料等级为 {needed}；当前可核验进度等级为 {effective_level}。"
    requirements = (
        ("requires_boss", "defeated_bosses", "首领挑战"),
        ("requires_research", "completed_research", "研究"),
        ("requires_technology", "unlocked_technologies", "前置科技"),
        ("requires_blueprint", "owned_blueprints", "设计图"),
    )
    for key, world_key, display in requirements:
        if item.get(key) and item[key] not in world.get(world_key, []):
            return f"无法确认 {label} 所需的{display}，暂不自动发放。"
    if item.get("ancient") and item.get("technology_id", item["id"]) not in world.get("unlocked_technologies", []):
        return f"无法确认 {label} 的古代科技解锁情况，暂不自动发放。"
    return None


def evaluate_request(catalog: Catalog, items, world, *, now=None, limits=None):
    """Validate a complete request and return an exact delivery plan.

    ``world`` is trusted collector data, never the model response. Required:
    observed_at (UTC ISO or epoch seconds), world_level (observed floor),
    player_level (bound player), source. Optional explicit unlock evidence is
    used for ancient/blueprint/boss gates. Ordinary levels represent assistance
    policy progression; they are not a claim that a technology was learned.

    The model must approve separately. This function can only constrain that
    approval. Daily quota/reservation/delivery persistence belong to Store.
    """
    limits = limits or PolicyLimits()
    now = time.time() if now is None else now
    if not isinstance(world, dict):
        return _denied("world_unavailable", "无法读取游戏世界进度，本次不扣次数。")
    observed = _timestamp(world.get("observed_at"))
    if observed is None or not -5 <= now - observed <= limits.world_max_age_seconds or not world.get("source"):
        return _denied("world_stale", "游戏进度数据尚未更新，本次不扣次数。")
    world_level = _level(world.get("world_level"))
    player_level = _level(world.get("player_level"))
    if world_level is None or player_level is None:
        return _denied("progression_unavailable", "尚未核验世界与绑定玩家等级，本次不扣次数。")
    effective_level = min(world_level, player_level)
    evidence = {"world_level": world_level, "player_level": player_level, "effective_level": effective_level, "observed_at": world["observed_at"], "source": world["source"], "progression_note": "等级仅代表已观测进度；不等于已解锁全部科技。"}
    runtime_version = str(world.get("game_version") or "").removeprefix("v")
    catalog_version = str(catalog.meta.get("game_version", "missing")).removeprefix("v")
    if runtime_version and runtime_version != catalog_version and not runtime_version.startswith(catalog_version + "."):
        return _denied("version_mismatch", "服务器版本与配方资料不一致，需要更新资料。", evidence)
    if not isinstance(items, list) or not 1 <= len(items) <= limits.max_request_lines:
        return _denied("invalid_items", f"请一次申请 1–{limits.max_request_lines} 种明确的物品。", evidence)
    requested = defaultdict(int)
    for request in items:
        if not isinstance(request, dict) or set(request) != {"item_id", "quantity"}:
            return _denied("invalid_items", "无法核对申请中的物品和数量。", evidence)
        quantity = request["quantity"]
        if type(quantity) is not int or not 1 <= quantity <= 2_147_483_647 or not isinstance(request["item_id"], str):
            return _denied("invalid_quantity", "数量必须是明确的正整数。", evidence)
        requested[request["item_id"]] += quantity
    deliveries = defaultdict(int)
    conversions = []
    for item_id, quantity in requested.items():
        item = catalog.get(item_id)
        if item is None:
            return _denied("unknown_item", "申请含有未收录的物品，无法核实游戏 ID。", evidence)
        failure = _gate(item, world, effective_level)
        if failure:
            return _denied("progression_denied", failure, evidence)
        category = item.get("category")
        direct_food = category in ("food", "ingredient")
        direct_medicine = category == "medicine"
        direct_basic = bool(item.get("direct_basic"))
        recipe = item.get("recipe")
        maximum = limits.max_food_quantity if direct_food else limits.max_medicine_quantity if direct_medicine else limits.max_material_quantity if direct_basic else limits.max_crafted_quantity * (recipe["output_quantity"] if recipe else 1)
        if quantity > maximum:
            return _denied("quantity_limit", f"每次 {item['name']} 最多申请 {maximum} 个。", evidence)
        if direct_basic or direct_food or direct_medicine:
            deliveries[item_id] += quantity
            continue
        if not recipe:
            return _denied("recipe_unavailable", f"尚无 {item['name']} 的可靠配方，不直接发成品。", evidence)
        batch_size = recipe["output_quantity"]
        if quantity % batch_size:
            return _denied("batch_quantity", f"{item['name']} 的配方每批产出 {batch_size} 个，请按整批数量申请。", evidence)
        batches = quantity // batch_size
        ingredients = []
        for ingredient in recipe["ingredients"]:
            component = catalog.get(ingredient["item_id"])
            if component is None or component.get("disabled") or component.get("category") not in ("material", "food", "ingredient", "medicine"):
                return _denied("recipe_component_unavailable", f"{item['name']} 的配方含有未核实或不支持发放的材料。", evidence)
            amount = ingredient["quantity"] * batches
            ingredients.append({"item_id": component["id"], "name": component["name"], "quantity": amount})
        # A verified recipe is still required as a progression and safety
        # gate, but the requested finished item is delivered directly.  The
        # ingredient details remain in the audit plan for traceability; they
        # are never added to ``deliveries``.
        deliveries[item_id] += quantity
        conversions.append({"item_id": item_id, "name": item["name"], "quantity": quantity, "ingredients": ingredients, "recipe_source": recipe["source"]})
    if len(deliveries) > limits.max_delivery_lines or sum(deliveries.values()) > limits.max_delivery_quantity or any(q > 2_147_483_647 for q in deliveries.values()):
        return _denied("delivery_limit", "申请总量超出单次补给范围，请减少申请数量。", evidence)
    return {"approved": True, "code": "approved", "reason": "已按实际物品资料、配方和观测进度核对。", "items": [{"item_id": i, "name": catalog.get(i)["name"], "quantity": q} for i, q in sorted(deliveries.items())], "conversions": conversions, "evidence": evidence}


def available_basic_foods(catalog: Catalog, world, *, quantity=1, now=None, limits=None):
    """Search our trusted catalogue and apply exactly the same grant gates.

    This is recommendation data, not an approval or a delivery. The final
    request still requires model review, a fresh world snapshot and quota.
    """
    return [item for item in catalog.basic_foods()
            if evaluate_request(catalog, [{"item_id": item["id"], "quantity": quantity}],
                                world, now=now, limits=limits)["approved"]]
