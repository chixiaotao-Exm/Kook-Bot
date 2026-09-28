import unittest
from unittest.mock import Mock
from collector import ProbeCollector, iso

NOW = 1790294400

class MusicHealthTests(unittest.TestCase):
    def collect(self, record, status='ready', descriptor=None, age=0):
        def request(url, **kwargs):
            if url.endswith('/api/session'): return {'authenticated': True}
            if url.endswith('/api/bots'): return {'bots': [{'id': 'default', 'name': '音乐机器人', 'online': True, 'status': status, **(descriptor or {})}]}
            return {'generatedAt': (NOW-age) * 1000, 'bots': [record] if record else []}
        return ProbeCollector(http=Mock(request=request), now=lambda: NOW).collect({'id': 'music', 'kind': 'music', 'url': 'https://example.test/'})[0]

    def test_transport_failure_and_source_stall_cannot_claim_successful_playback(self):
        for record in [{'id': 'default', 'status': 'playing', 'transport': 'disconnected', 'issue': '语音发送连接已中断', 'level': 'error'},
                       {'id': 'default', 'status': 'playing', 'transport': 'connected', 'issue': '音源无新进度', 'level': 'warning'}]:
            result = self.collect(record)
            self.assertEqual(result['state'], 'online'); self.assertEqual(result['health'], 'degraded'); self.assertFalse(result['playing'])
            self.assertEqual(result['transport'], record['transport']); self.assertTrue(result['lastError'])

    def test_missing_health_record_is_unknown_but_intentionally_idle_voice_is_healthy(self):
        self.assertEqual(self.collect(None)['health'], 'unknown')
        result = self.collect({'id': 'default', 'status': 'idle', 'transport': 'disconnected', 'issue': '', 'level': 'info'})
        self.assertEqual(result['health'], 'healthy'); self.assertFalse(result['playing'])
        good = self.collect({'id': 'default', 'status': 'playing', 'transport': 'connected', 'issue': '', 'level': 'info'})
        self.assertEqual(good['health'], 'healthy'); self.assertTrue(good['playing'])

    def test_intentionally_stopped_bot_ignores_old_disconnection_diagnostic(self):
        result = self.collect({'id': 'default', 'status': 'idle', 'transport': 'disconnected', 'issue': '消息连接中断', 'level': 'warning'}, status='stopping')
        self.assertEqual(result['state'], 'stopped'); self.assertEqual(result['health'], 'healthy'); self.assertFalse(result['playing']); self.assertEqual(result['lastError'], '')

    def test_music_runtime_is_sampled_from_each_descriptor_and_kept_through_gateway_offline(self):
        record = {'id': 'default', 'status': 'idle'}
        descriptor = {'uptimeSeconds': 3661.9, 'startedAt': iso(NOW-3661)}
        result = self.collect(record, descriptor=descriptor)
        self.assertEqual(result['uptimeSeconds'], 3661); self.assertEqual(result['startedAt'], iso(NOW-3661))
        result = self.collect(record, descriptor={**descriptor, 'online': False})
        self.assertEqual(result['uptimeSeconds'], 3661)
        restarted = self.collect(record, descriptor={'uptimeSeconds': 0, 'startedAt': iso(NOW)})
        self.assertEqual(restarted['uptimeSeconds'], 0); self.assertEqual(restarted['startedAt'], iso(NOW))
        self.assertIsNone(self.collect(record)['uptimeSeconds'])

    def test_invalid_stale_missing_and_stopped_runtime_values_are_not_presented_as_current(self):
        record = {'id': 'default', 'status': 'idle'}
        descriptor = {'uptimeSeconds': 600, 'startedAt': iso(NOW-600)}
        for result in [self.collect(record, descriptor=descriptor, age=121), self.collect(record, status='stopped', descriptor=descriptor),
                       self.collect(None, descriptor=descriptor), self.collect(record, descriptor={**descriptor, 'online': None})]:
            self.assertIsNone(result['uptimeSeconds']); self.assertIsNone(result['startedAt'])
        for value in (-1, True, '60', float('inf'), float('nan'), 1e13):
            result = self.collect(record, descriptor={'uptimeSeconds': value, 'startedAt': 'invalid'})
            self.assertIsNone(result['uptimeSeconds']); self.assertIsNone(result['startedAt'])
        self.assertIsNone(self.collect(record, descriptor={**descriptor, 'startedAt': iso(NOW+3600)})['startedAt'])
        collector = ProbeCollector(http=Mock(request=Mock(side_effect=TimeoutError())))
        result = collector.collect({'id':'music','kind':'music','url':'http://127.0.0.1:8787'})[0]
        self.assertIsNone(result['uptimeSeconds']); self.assertIsNone(result['startedAt'])

if __name__ == '__main__': unittest.main()
