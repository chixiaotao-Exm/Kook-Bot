import unittest
from model import Model
from runtime import event_text


class Fake:
    def __init__(self, result):
        self.result = result

    async def request(self, path, body):
        self.body = body
        return self.result


class ModelTests(unittest.IsolatedAsyncioTestCase):
    async def test_incomplete_cannot_approve(self):
        model = Model('http://127.0.0.1/v1', 'test')
        model.client = Fake({'status': 'incomplete', 'output': []})
        with self.assertRaises(ValueError):
            await model.decide('申请木头10', {}, [])

    async def test_valid_and_mismatched_model(self):
        result = {'status': 'completed', 'model': 'gpt-6-astra', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '{"intent":"request","approved":true,"items":[{"item_id":"Wood","quantity":10}],"reason":"基础补给","reply":"可申请"}'}]}]}
        model = Model('http://127.0.0.1/v1', 'test')
        model.client = Fake(result)
        self.assertEqual((await model.decide('申请木头10', {}, [{'id': 'Wood'}]))['items'][0]['quantity'], 10)
        self.assertFalse(model.client.body['store'])
        result['model'] = 'unexpected-model'
        with self.assertRaises(ValueError):
            await model.decide('申请木头10', {}, [])

    async def test_unknown_candidate_cannot_be_granted(self):
        result = {'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '{"intent":"request","approved":true,"items":[{"item_id":"Money","quantity":10}],"reason":"","reply":""}'}]}]}
        model = Model('http://127.0.0.1/v1', 'test')
        model.client = Fake(result)
        with self.assertRaises(ValueError):
            await model.decide('申请木头10', {}, [{'id': 'Wood'}])

    async def test_boolean_quantity_is_not_an_integer_grant(self):
        model = Model('http://127.0.0.1/v1', 'test')
        model.client = Fake({'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '{"intent":"request","approved":true,"items":[{"item_id":"Wood","quantity":true}],"reason":"","reply":""}'}]}]})
        with self.assertRaises(ValueError):
            await model.decide('申请木头', {}, [])

    def test_location_evidence_uses_actual_units(self):
        text = event_text({'type': 'player_kill', 'killer_name': 'A', 'victim_name': 'B', 'position': {'x': 100, 'y': 200, 'z': 300}})
        self.assertIn('(100, 200) 厘米', text)
        self.assertIn('A', text)
