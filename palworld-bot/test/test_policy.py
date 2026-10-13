"""Synthetic fixtures test decisions without redistributing game datasets."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog import Catalog, food_intent, quantity_followup
from policy import PolicyLimits, evaluate_request, available_basic_foods
from unittest.mock import patch


def fixture():
    # These invented IDs, levels and recipes are test data, not game facts.
    document = {"schema_version": 1, "game_version": "1.2.3", "items": [
        {"id": "TestLog", "name": "测试原料", "en": "Fixture log", "category": "material", "required_level": 1, "direct_basic": True},
        {"id": "TestOre", "name": "测试矿物", "category": "material", "required_level": None},
        {"id": "TestMeal", "name": "测试食品", "category": "food", "required_level": 1,
         "recipe": {"output_quantity": 1, "source": "synthetic", "ingredients": [{"item_id": "TestLog", "quantity": 7}]}},
        {"id": "TestMedicine", "name": "测试药品", "category": "medicine", "required_level": 2,
         "recipe": {"output_quantity": 1, "source": "synthetic", "ingredients": [{"item_id": "TestOre", "quantity": 6}]}},
        {"id": "TestTool", "name": "测试工具", "category": "weapon", "required_level": 5,
         "recipe": {"output_quantity": 1, "source": "synthetic", "ingredients": [{"item_id": "TestLog", "quantity": 4}, {"item_id": "TestOre", "quantity": 3}]}},
        {"id": "TestAmmo", "name": "测试弹药", "category": "ammo", "required_level": 5,
         "recipe": {"output_quantity": 10, "source": "synthetic", "ingredients": [{"item_id": "TestLog", "quantity": 2}]}},
        {"id": "TestRelic", "name": "测试古代装备", "category": "weapon", "required_level": 1, "ancient": True,
         "recipe": {"output_quantity": 1, "source": "synthetic", "ingredients": [{"item_id": "TestLog", "quantity": 2}]}},
        {"id": "TestUnknown", "name": "测试未知成品", "category": "weapon", "required_level": 1},
        {"id": "TestFuture", "name": "测试后期食物", "category": "food", "required_level": 50},
        {"id": "TestKey", "name": "测试特殊钥匙", "category": "key", "required_level": 1},
    ]}
    return Catalog(document)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.catalog = fixture()
        self.world = {"observed_at": 1000, "world_level": 20, "player_level": 10, "source": "test_rest_observed_level_floor", "game_version": "1.2.3.456"}

    def decide(self, *pairs, **kwargs):
        return evaluate_request(self.catalog, [{"item_id": i, "quantity": q} for i, q in pairs], self.world, now=1001, **kwargs)

    def test_basics_match_explicit_request(self):
        result = self.decide(("TestLog", 42))
        self.assertTrue(result["approved"])
        self.assertEqual(result["items"], [{"item_id": "TestLog", "name": "测试原料", "quantity": 42}])

    def test_finished_item_is_delivered_after_verified_recipe_check(self):
        result = self.decide(("TestTool", 1), ("TestLog", 10))
        self.assertTrue(result["approved"])
        self.assertEqual({r["item_id"]: r["quantity"] for r in result["items"]}, {"TestLog": 10, "TestTool": 1})
        self.assertEqual(result["conversions"][0]["recipe_source"], "synthetic")
        self.assertEqual(result["conversions"][0]["ingredients"], [
            {"item_id": "TestLog", "name": "测试原料", "quantity": 4},
            {"item_id": "TestOre", "name": "测试矿物", "quantity": 3},
        ])

    def test_food_medicine_receive_finished_items(self):
        result = self.decide(("TestMeal", 2), ("TestMedicine", 3))
        self.assertTrue(result["approved"])
        self.assertEqual({r["item_id"]: r["quantity"] for r in result["items"]}, {"TestMeal": 2, "TestMedicine": 3})
        self.assertEqual(result["conversions"], [])

    def test_player_progress_still_matters_in_advanced_world(self):
        self.world["player_level"] = 2
        self.assertEqual(self.decide(("TestTool", 1))["code"], "progression_denied")

    def test_world_progress_never_defaults_to_permissive(self):
        del self.world["world_level"]
        self.assertEqual(self.decide(("TestLog", 1))["code"], "progression_unavailable")

    def test_late_food_is_not_unconditionally_unlocked(self):
        self.assertFalse(self.decide(("TestFuture", 1))["approved"])

    def test_stale_and_future_samples_deny_without_plan(self):
        for observed in (800, 1007, "2020-01-01T00:00:00", float("nan")):
            self.world["observed_at"] = observed
            result = self.decide(("TestLog", 1))
            self.assertEqual(result["code"], "world_stale")
            self.assertEqual(result["items"], [])

    def test_recipe_unknown_does_not_grant_product(self):
        self.assertEqual(self.decide(("TestUnknown", 1))["code"], "recipe_unavailable")

    def test_no_level_metadata_does_not_grant_raw_late_resource(self):
        self.assertEqual(self.decide(("TestOre", 1))["code"], "progression_denied")

    def test_duplicate_lines_cannot_bypass_quantity_cap(self):
        result = self.decide(("TestLog", 60), ("TestLog", 60))
        self.assertEqual(result["code"], "quantity_limit")

    def test_boolean_negative_fraction_and_excessive_quantities_fail(self):
        for quantity in (True, -1, 0, 1.5, "1", 2_147_483_648):
            self.assertEqual(self.decide(("TestLog", quantity))["code"], "invalid_quantity")

    def test_model_recipe_injection_is_rejected(self):
        result = evaluate_request(self.catalog, [{"item_id": "TestTool", "quantity": 1, "recipe": [{"item_id": "TestRelic", "quantity": 1}]}], self.world, now=1001)
        self.assertEqual(result["code"], "invalid_items")

    def test_entire_request_rejected_before_any_partial_delivery(self):
        result = self.decide(("TestLog", 20), ("TestKey", 1))
        self.assertFalse(result["approved"])
        self.assertEqual(result["items"], [])

    def test_ancient_requires_evidence(self):
        self.assertFalse(self.decide(("TestRelic", 1))["approved"])
        self.world["unlocked_technologies"] = ["TestRelic"]
        self.assertTrue(self.decide(("TestRelic", 1))["approved"])

    def test_blueprint_boss_and_research_require_exact_evidence(self):
        self.catalog.items["TestTool"].update(requires_blueprint="TestBlueprint", requires_boss="TestBoss", requires_research="TestResearch")
        self.assertFalse(self.decide(("TestTool", 1))["approved"])
        self.world.update(owned_blueprints=["TestBlueprint"], defeated_bosses=["TestBoss"], completed_research=["TestResearch"])
        self.assertTrue(self.decide(("TestTool", 1))["approved"])

    def test_crafting_output_batches_preserve_finished_item_quantity(self):
        self.assertEqual(self.decide(("TestAmmo", 1))["code"], "batch_quantity")
        result = self.decide(("TestAmmo", 10))
        self.assertTrue(result["approved"])
        self.assertEqual(result["items"], [{"item_id": "TestAmmo", "name": "测试弹药", "quantity": 10}])
        self.assertEqual(self.decide(("TestAmmo", 20))["code"], "quantity_limit")

    def test_recipe_cannot_smuggle_equipment_as_a_component(self):
        self.catalog.items["TestTool"]["recipe"]["ingredients"] = [{"item_id": "TestRelic", "quantity": 1}]
        self.assertEqual(self.decide(("TestTool", 1))["code"], "recipe_component_unavailable")

    def test_combined_delivery_volume_is_bounded(self):
        self.assertEqual(self.decide(("TestAmmo", 10), limits=PolicyLimits(max_delivery_quantity=6))["code"], "delivery_limit")

    def test_version_prefix_is_not_a_version_match(self):
        self.world["game_version"] = "1.2.30"
        self.assertEqual(self.decide(("TestLog", 1))["code"], "version_mismatch")

    def test_catalogue_returns_evidence_to_model(self):
        matches = self.catalog.search("申请测试工具一把")
        self.assertEqual(matches[0]["id"], "TestTool")
        self.assertEqual(matches[0]["recipe"]["source"], "synthetic")

    def test_common_language_aliases_find_specific_items(self):
        catalogue = Catalog({"schema_version": 1, "items": [{"id": "Wood", "name": "木材", "category": "material"}]})
        self.assertEqual(catalogue.search("我想要木头20个")[0]["id"], "Wood")
        self.assertEqual(catalogue.search("给我食物5份"), [])

    def test_one_character_item_names_in_natural_requests(self):
        catalogue = Catalog({"schema_version": 1, "items": [{"id": "FixtureArrow", "name": "箭", "category": "ammo"}, {"id": "FixtureCloth", "name": "布", "category": "material"}]})
        self.assertEqual(catalogue.search("申请箭10支")[0]["id"], "FixtureArrow")
        self.assertEqual(catalogue.search("给我10支箭")[0]["id"], "FixtureArrow")
        self.assertEqual(catalogue.search("布2个")[0]["id"], "FixtureCloth")
        self.assertEqual(catalogue.search("发布公告"), [])

    def test_catalogue_rejects_malformed_recipe(self):
        document = {"schema_version": 1, "items": [copy.deepcopy(self.catalog.get("TestTool"))]}
        document["items"][0]["recipe"]["ingredients"][0]["quantity"] = True
        with self.assertRaises(ValueError):
            Catalog(document)

    def test_basic_food_recommendations_use_the_same_progression_gates(self):
        with patch('catalog.DEFAULT_FOOD_IDS', ('TestMeal', 'TestFuture', 'TestKey')):
            self.assertEqual([i['id'] for i in available_basic_foods(self.catalog, self.world, now=1001)], ['TestMeal'])
            self.world['observed_at'] = 100
            self.assertEqual(available_basic_foods(self.catalog, self.world, now=1001), [])

    def test_recommendations_do_not_invent_food_when_catalogue_has_none(self):
        with patch('catalog.DEFAULT_FOOD_IDS', ('MissingFood', 'TestOre')):
            self.assertEqual(self.catalog.basic_foods(), [])

    def test_disabled_and_unverified_food_are_not_recommended(self):
        with patch('catalog.DEFAULT_FOOD_IDS', ('TestMeal',)):
            for patch_value in ({'disabled': True}, {'required_level': None}, {'requires_blueprint': 'Missing'}):
                catalog = fixture()
                catalog.items['TestMeal'].update(patch_value)
                self.assertEqual(available_basic_foods(catalog, self.world, now=1001), [])

    def test_quantity_tokens_do_not_match_unrelated_numeric_item_ids(self):
        catalog = Catalog({'schema_version': 1, 'items': [
            {'id': 'Meal', 'name': '测试食品', 'category': 'food'},
            {'id': 'Blueprint010', 'name': '无关图纸', 'category': 'blueprint'},
        ]})
        self.assertEqual([i['id'] for i in catalog.search('申请测试食品 10 个')], ['Meal'])
        self.assertEqual(catalog.search('10'), [])

    def test_generic_food_intent_requires_whole_message_match(self):
        for text in ('申请食物10份', '给我10份食物', '食物10份', '我要普通食物十份'):
            self.assertEqual(food_intent(text), {'kind': 'request', 'quantity': 10})
        for text in ('来点吃的', '给我吃点'):
            self.assertEqual(food_intent(text), {'kind': 'request', 'quantity': None})
        for text in ('我饿了', '有什么食物', '推荐吃什么', '想吃东西'):
            self.assertEqual(food_intent(text)['kind'], 'browse')
        for text in ('不要食物10份', '申请食物10份和石头20个', '为什么申请食物10份', '不是要10份食物', '申请神秘食物10份', '申请食物-10份', '申请食物1.5份'):
            self.assertIsNone(food_intent(text), text)
        self.assertEqual(quantity_followup('10份'), 10)
        self.assertEqual(quantity_followup('二十份'), 20)
        for text in ('不是10份', '10或20份', '0份', '1.5份', '10000000000份'):
            self.assertIsNone(quantity_followup(text))


if __name__ == "__main__":
    unittest.main()
