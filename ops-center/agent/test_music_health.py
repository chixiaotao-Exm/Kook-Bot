import unittest
from unittest.mock import Mock
from collector import ProbeCollector

NOW = 1790294400

class MusicHealthTests(unittest.TestCase):
    def collect(self, record, status='ready'):
        def request(url, **kwargs):
            if url.endswith('/api/session'): return {'authenticated': True}
            if url.endswith('/api/bots'): return {'bots': [{'id': 'default', 'name': '音乐机器人', 'online': True, 'status': status}]}
            return {'generatedAt': NOW * 1000, 'bots': [record] if record else []}
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

if __name__ == '__main__': unittest.main()
