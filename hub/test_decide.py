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

    def test_model_decides_first_and_its_reason_is_kept(self):
        r = decide(ev(conf=0.4), [], CFG, lambda *a: ("held", "Looks accidental."))
        self.assertEqual(r, {"action": "held", "reason": "Looks accidental.", "by": "model"})
        r = decide(ev(), [sent(t=995)], CFG, lambda *a: ("held", "Just sent."))
        self.assertEqual((r["action"], r["by"]), ("held", "model"))

    def test_model_cannot_hold_a_clear_new_word(self):
        # seen live: the model held a 95% "food" because an emergency had just gone out for another word
        for conf in (0.95, None):
            r = decide(ev("food", conf=conf), [sent("water", t=998, action="call")], CFG, lambda *a: ("held", "busy"))
            self.assertEqual((r["action"], r["by"]), ("text", "rules"))
        self.assertEqual(decide(ev(), [], CFG, lambda *a: "call")["reason"], "Chosen by the decision model.")

    def test_model_is_asked_even_for_weak_and_repeated_gestures(self):
        # DELIBERATE (team decision 2026-11-14): with a model present, the threshold is a hint to it, not a gate.
        self.assertEqual(decide(ev(conf=0.1), [], CFG, lambda *a: ("text", "ok"))["action"], "text")
        self.assertEqual(decide(ev(), [sent(t=999)], CFG, lambda *a: ("text", "ok"))["action"], "text")

    def test_model_cannot_hold_an_urgent_word(self):
        r = decide(ev("hurt"), [], CFG, lambda *a: ("held", "probably nothing"))
        self.assertEqual((r["action"], r["by"]), ("call", "rules"))

    def test_model_error_or_junk_falls_back_to_the_rules(self):
        def raises(*a):
            raise RuntimeError("x")
        for ask in (raises, lambda *a: None, lambda *a: "banana", lambda *a: ("banana", "x")):
            self.assertEqual(decide(ev(), [], CFG, ask), decide(ev(), [], CFG))
            self.assertEqual(decide(ev(conf=0.1), [], CFG, ask)["action"], "held")

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
