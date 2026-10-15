import tempfile
import unittest
from pathlib import Path
from runtime import Runtime


class RuntimeTests(unittest.TestCase):
    def test_event_delivery_is_bounded_across_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'runtime.sqlite'
            runtime = Runtime(path)
            self.assertTrue(runtime.allow_event_delivery('42'))
            self.assertTrue(runtime.allow_event_delivery('42'))
            self.assertTrue(runtime.allow_event_delivery('42'))
            self.assertFalse(runtime.allow_event_delivery('42'))
            self.assertFalse(Runtime(path).allow_event_delivery('42'))
