"""Load an operator-supplied item catalogue; never trust model-supplied recipes.

The public repository deliberately contains no third-party game dataset.  The
``build`` command accepts files the operator has obtained under their licences
and writes a normalized runtime file outside the source checkout.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from pathlib import Path


ITEM_ID = re.compile(r"^[A-Za-z0-9_]{1,128}$")
BASIC_MATERIALS = frozenset({"Wood", "Stone", "Fiber", "Wool", "Leather", "Pal_crystal_S"})
EXCLUDED_CATEGORIES = frozenset({"blueprint", "key", "structure", "pal_gear", "pal_egg", "skill_fruit", "enhancement"})
COMMON_ALIASES = {
    "Wood": ["木头", "木料"], "Stone": ["石块"],
    "Berries": ["野莓", "红莓"], "Baked_Berries": ["烤莓"],
    "Herbs": ["低级药", "低级药品"], "Medicines": ["普通药品"],
    "LuxuryMedicines": ["高级药品"], "Pickaxe_Tier_00": ["石镐", "石制镐"],
    "Axe_Tier_00": ["石斧"], "WeakerBow": ["旧弓", "陈旧弓"],
}


def _positive_int(value, label):
    if type(value) is not int or not 1 <= value <= 2_147_483_647:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _validate_item(item):
    if not isinstance(item, dict) or not ITEM_ID.fullmatch(str(item.get("id", ""))):
        raise ValueError("invalid item ID")
    if not isinstance(item.get("name"), str) or not item["name"].strip():
        raise ValueError("item name is required")
    for key in ("direct_basic", "disabled", "ancient", "ambiguous_progression"):
        if key in item and type(item[key]) is not bool:
            raise ValueError(f"{key} must be a boolean")
    level = item.get("required_level")
    if level is not None and (type(level) is not int or not 1 <= level <= 100):
        raise ValueError("invalid required_level")
    recipe = item.get("recipe")
    if recipe is not None:
        if not isinstance(recipe, dict) or not isinstance(recipe.get("source"), str) or not recipe["source"]:
            raise ValueError("recipe source is required")
        _positive_int(recipe.get("output_quantity"), "recipe output_quantity")
        ingredients = recipe.get("ingredients")
        if not isinstance(ingredients, list) or not 1 <= len(ingredients) <= 32:
            raise ValueError("recipe ingredients are required")
        for ingredient in ingredients:
            if not isinstance(ingredient, dict) or not ITEM_ID.fullmatch(str(ingredient.get("item_id", ""))):
                raise ValueError("invalid recipe ingredient ID")
            _positive_int(ingredient.get("quantity"), "ingredient quantity")


class Catalog:
    def __init__(self, document):
        if not isinstance(document, dict) or document.get("schema_version") != 1:
            raise ValueError("unsupported catalogue schema")
        if not isinstance(document.get("items"), list):
            raise ValueError("catalogue items must be a list")
        self.meta = {k: copy.deepcopy(v) for k, v in document.items() if k != "items"}
        self.items = {}
        for original in document["items"]:
            item = copy.deepcopy(original)
            _validate_item(item)
            item["aliases"] = list(dict.fromkeys(item.get("aliases", []) + COMMON_ALIASES.get(item["id"], [])))
            if item["id"] in self.items:
                raise ValueError("duplicate catalogue item ID")
            self.items[item["id"]] = item
        if not self.items:
            raise ValueError("empty catalogue")

    @classmethod
    def from_file(cls, path):
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def get(self, item_id):
        return self.items.get(item_id)

    def search(self, query, limit=20):
        """Return only factual catalogue matches; never guess a recipe or ID."""
        if not isinstance(query, str) or not query.strip():
            return []
        query = query.casefold().strip()
        tokens = re.findall(r"[\w]+", query)
        chinese_terms = []
        for term in re.findall(r"[\u3400-\u9fff]+", query):
            term = re.sub(r"^(?:请|帮我|给我|我想要|我想申请|我要|想要|需要|申请|领取|补给|能给我|可以给我)+", "", term)
            term = re.sub(r"^(?:[一二两三四五六七八九十百]+)?(?:个|份|支|把|瓶|块)", "", term)
            if term and term not in ("个", "份", "支", "把", "瓶", "块", "和", "谢谢"):
                chinese_terms.append(term)
        matches = []
        for item in self.items.values():
            fields = [item["id"].casefold(), item["name"].casefold(), item.get("en", "").casefold()]
            fields.extend(str(alias).casefold() for alias in item.get("aliases", []))
            score = 0
            for field in fields:
                if not field:
                    continue
                if field == query:
                    score = max(score, 100)
                elif len(field) >= 2 and field in query:
                    score = max(score, 65 + min(len(field), 25))
                elif query in field:
                    score = max(score, 50)
                elif any(len(token) > 1 and token in field for token in tokens):
                    score = max(score, 20)
                elif any(term in field for term in chinese_terms):
                    score = max(score, 45 if field in chinese_terms else 25)
            if score:
                matches.append((score, item["id"], item))
        matches.sort(key=lambda match: (-match[0], match[1]))
        return [self.model_item(item) for _, _, item in matches[:max(1, min(int(limit), 100))]]

    @staticmethod
    def model_item(item):
        return {k: copy.deepcopy(item.get(k)) for k in (
            "id", "name", "en", "aliases", "category", "required_level", "progression_basis",
            "direct_basic", "disabled", "recipe", "requires_technology", "requires_boss",
            "requires_research", "requires_blueprint", "ancient",
        )}


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _station_name(value):
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def build_catalog(item_catalog_path, recipes_path, save_pal_directory):
    """Normalize factual data, preserving the provenance and uncertain gates.

    Item names/category come from the operator's existing catalogue. Medicine
    is classified by the game type_b==Medicine, never name substrings. Recipe
    gates come from the extracted recipe/technology records. A station-level
    fallback is explicitly marked as a proxy, not evidence of unlock ownership.
    """
    source_catalog = _read(item_catalog_path)
    recipes_document = _read(recipes_path)
    root = Path(save_pal_directory)
    item_types = _read(root / "items.json")
    technologies = _read(root / "technologies.json")
    building_names = _read(root / "l10n" / "en" / "buildings.json")
    recipe_index = {}
    duplicate_recipes = set()
    for recipe in recipes_document["recipes"]:
        key = recipe["productId"]
        if key in recipe_index:
            duplicate_recipes.add(key)
        recipe_index[key] = recipe
    source_version = source_catalog.get("meta", {}).get("gameVersion")
    recipe_version = recipes_document.get("gameVersion")
    if not source_version or source_version != recipe_version:
        raise ValueError("item and recipe game versions differ")
    station_levels = {}
    item_tech = {}
    for technology_id, technology in technologies.items():
        level = technology.get("level_cap")
        if type(level) is not int or level < 1:
            continue
        for building_id in technology.get("unlock_build_objects", []):
            name = _station_name(building_names.get(building_id, {}).get("localized_name", ""))
            if name:
                station_levels[name] = min(station_levels.get(name, 100), level)
        for item_id in technology.get("unlock_item_recipes", []):
            item_tech.setdefault(item_id, []).append((technology_id, technology))
    normalized = []
    for original in source_catalog["items"]:
        item_id = original["id"]
        typed = item_types.get(item_id, {})
        recipe = recipe_index.get(item_id)
        category = original.get("category", "unknown")
        if typed.get("type_b") == "Medicine":
            category = "medicine"
        item = {
            "id": item_id, "name": original["name"], "en": original.get("en", ""),
            "category": category, "rarity": original.get("rarity"),
            "aliases": COMMON_ALIASES.get(item_id, []),
            "disabled": bool(typed.get("disabled") or typed.get("redirect_to")),
            "direct_basic": item_id in BASIC_MATERIALS,
            "required_level": None, "progression_basis": "unknown",
        }
        if item_id in BASIC_MATERIALS:
            item.update(required_level=1, progression_basis="operator_basic_assistance")
        elif category in ("food", "ingredient", "medicine") and not recipe:
            # Natural food is allowed by the assistance policy, not a claim that
            # every food has an in-game level-1 crafting unlock.
            item.update(required_level=1, progression_basis="operator_food_assistance")
        if recipe and item_id not in duplicate_recipes:
            item["recipe"] = {
                "output_quantity": recipe["productCount"],
                "ingredients": [{"item_id": m["codename"], "quantity": m["count"]} for m in recipe["materials"]],
                "source": "PalSphere:recipes.json:" + item_id,
            }
            if recipe.get("unlockItemId"):
                item["requires_blueprint"] = recipe["unlockItemId"]
            item["ancient"] = recipe.get("unlockTechType") == "ancient"
            level = recipe.get("unlockTechLevel")
            if type(level) is int and level >= 1:
                item.update(required_level=level, progression_basis="recipe_technology_level")
            elif not item["direct_basic"]:
                levels = [station_levels[_station_name(s.get("displayName", ""))] for s in recipe.get("stations", []) if _station_name(s.get("displayName", "")) in station_levels]
                if levels:
                    item.update(required_level=min(levels), progression_basis="minimum_recipe_station_level")
            tech_records = item_tech.get(item_id, [])
            # Divergent prerequisite paths cannot be silently collapsed.
            if len(tech_records) == 1:
                technology_id, technology = tech_records[0]
                item["technology_id"] = technology_id
                item["ancient"] = item.get("ancient", False) or bool(technology.get("is_boss_technology"))
                for field, target in (("require_defeat_tower_boss", "requires_boss"), ("require_research_id", "requires_research"), ("require_technology", "requires_technology")):
                    value = technology.get(field)
                    if value and value not in ("None", "EPalBossType::None"):
                        item[target] = value
            elif len(tech_records) > 1:
                item["ambiguous_progression"] = True
        normalized.append(item)
    sources = [
        {"name": "Operator item catalogue", "sha256": _digest(item_catalog_path), "upstream": source_catalog.get("meta", {}).get("sources", [])},
        {"name": "PalSphere", "url": "https://palsphere.app", "repository": "https://github.com/palsphere/palsphere-data", "file": "data/recipes.json", "sha256": _digest(recipes_path), "license": "PalSphere Data License; personal/educational/non-commercial only without written permission", "game_version": recipe_version},
        {"name": "Palworld Save Pal", "repository": "https://github.com/oMaN-Rod/palworld-save-pal", "license": "GPL-3.0", "files": [{"name": str(path.relative_to(root)), "sha256": _digest(path)} for path in (root / "items.json", root / "technologies.json", root / "l10n/en/buildings.json")]},
    ]
    document = {"schema_version": 1, "game_version": source_version, "sources": sources, "items": normalized}
    Catalog(document)  # Refuse malformed datasets before replacing runtime data.
    return document


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--items", required=True)
    parser.add_argument("--recipes", required=True)
    parser.add_argument("--save-pal-data", required=True)
    parser.add_argument("--output", required=True, help="Private runtime path outside the public checkout")
    args = parser.parse_args()
    destination = Path(args.output).resolve()
    if Path(__file__).resolve().parent in destination.parents:
        raise SystemExit("Write third-party runtime data outside the public bot source directory")
    document = build_catalog(args.items, args.recipes, args.save_pal_data)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"items": len(document["items"]), "recipes": sum(bool(i.get("recipe")) for i in document["items"]), "game_version": document["game_version"]}))
