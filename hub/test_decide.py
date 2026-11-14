import os
import tempfile
import unittest
from unittest import mock

from hub import keys
from hub.decide import decide

CFG = {}


def ev(gesture="water", conf=0.93, t=1000):
    return {"gesture": gesture, "confidence": conf, "time": t}


def sent(gesture="water", t=990, action="text"):
    return {"gesture": gesture, "time": t, "action": action}


class Boom:
    called = False

    def __call__(self, *a):
        Boom.called = True
        return "call"


class DecideTests(unittest.TestCase):
    def test_low_confidence_held(self):
        r = decide(ev(conf=0.62), [], CFG)
        self.assertEqual(r["action"], "held")
        self.assertIn("62%", r["reason"])

    def test_none_confidence_passes(self):
        self.assertEqual(decide(ev(conf=None), [], CFG)["action"], "text")

    def test_repeat_within_window_held(self):
        self.assertEqual(decide(ev(), [sent(t=990)], CFG)["action"], "held")

    def test_same_gesture_after_window_sent(self):
        self.assertEqual(decide(ev(), [sent(t=970)], CFG)["action"], "text")

    def test_held_earlier_event_is_not_a_repeat(self):
        self.assertEqual(decide(ev(), [sent(t=990, action="held")], CFG)["action"], "text")

    def test_urgent_calls_even_when_repeated(self):
        r = decide(ev("hurt"), [sent("hurt", t=999, action="call")], CFG)
        self.assertEqual(r["action"], "call")

    def test_urgent_with_low_confidence_is_still_held(self):
        # DELIBERATE: the threshold is final, even for urgent gestures. A weak "hurt"
        # is held and nothing is sent. To change this, move the urgent check above rule 1
        # in decide() and update this test.
        self.assertEqual(decide(ev("hurt", conf=0.5), [], CFG)["action"], "held")

    def test_model_can_escalate_or_hold(self):
        self.assertEqual(decide(ev(), [], CFG, lambda *a: "call")["action"], "call")
        r = decide(ev(), [], CFG, lambda *a: "held")
        self.assertEqual((r["action"], r["reason"]), ("held", "Chosen by the decision model."))

    def test_model_error_or_junk_keeps_text(self):
        def raises(*a):
            raise RuntimeError("x")
        for ask in (raises, lambda *a: None, lambda *a: "banana"):
            self.assertEqual(decide(ev(), [], CFG, ask)["action"], "text")

    def test_model_not_called_for_held_or_urgent(self):
        Boom.called = False
        decide(ev(conf=0.1), [], CFG, Boom())
        decide(ev(), [sent(t=999)], CFG, Boom())
        decide(ev("hurt"), [], CFG, Boom())
        self.assertFalse(Boom.called)

    def test_custom_threshold(self):
        cfg = {"rules": {"threshold": 0.95}}
        self.assertEqual(decide(ev(conf=0.93), [], cfg)["action"], "held")
        cfg = {"rules": {"threshold": 0.5}}
        self.assertEqual(decide(ev(conf=0.6), [], cfg)["action"], "text")


class KeysTests(unittest.TestCase):
    def test_reads_env_file_and_prefers_environment(self):
        old = os.getcwd()
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, ".env"), "w") as f:
                f.write("# note\n\nEPS_TEST_A=\"from-file\"\nEPS_TEST_B=file-b\n")
            os.chdir(d)
            try:
                with mock.patch.dict(os.environ, {"EPS_TEST_B": "from-env"}):
                    os.environ.pop("EPS_TEST_A", None)
                    self.assertEqual(keys.get("EPS_TEST_A"), "from-file")
                    self.assertEqual(keys.get("EPS_TEST_B"), "from-env")
                    self.assertEqual(keys.get("EPS_TEST_MISSING"), "")
            finally:
                os.chdir(old)


if __name__ == "__main__":
    unittest.main()
