"""Tests for hub/insight.py and POST /api/insight. No network: urlopen is patched."""
import io, json, tempfile, threading, time, unittest, urllib.request
from unittest import mock

from hub import insight
from hub.app import make_server

NOW = 1_800_000_000
EVENTS = [{"time": NOW - 600, "gesture": "water", "action": "text", "confidence": 0.93, "via": "gesture"},
          {"time": NOW - 60, "gesture": "water", "action": "held", "confidence": 0.4, "via": "gesture", "reason": "weak"}]
CONFIG = {"child": "Zorbo", "contact": "+15550001111"}


class Insight(unittest.TestCase):
    def test_empty_window_needs_no_key_or_network(self):
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError), mock.patch.object(insight.keys, "get", return_value=None):
            out = insight.summarise([{"time": NOW - 200000, "gesture": "x", "action": "text"}], CONFIG, now=NOW)
        self.assertEqual(out, {"summary": "No messages in the last day.", "suggestion": ""})

    def test_missing_key(self):
        with mock.patch.object(insight.keys, "get", return_value=None):
            self.assertIsNone(insight.summarise(EVENTS, CONFIG, now=NOW))

    def test_canned_reply_and_private_details_stay_home(self):
        reply = {"candidates": [{"content": {"parts": [{"text": json.dumps({"summary": "Water twice.", "suggestion": ""})}]}}]}
        seen = []
        def fake(req, timeout=None):
            seen.append(req.data.decode())
            return io.BytesIO(json.dumps(reply).encode())
        with mock.patch.object(insight.keys, "get", side_effect=lambda k: "k" if k == "GEMINI_API_KEY" else None), \
                mock.patch("urllib.request.urlopen", fake):
            out = insight.summarise(EVENTS, CONFIG, now=NOW)
        self.assertEqual(out["summary"], "Water twice.")
        self.assertEqual((out["suggestion"], out["model"]), ("", "gemini-4-hydrogen"))
        self.assertIn("ms", out)
        self.assertIn("water", seen[0])
        self.assertNotIn("Zorbo", seen[0])
        self.assertNotIn("5550001111", seen[0])


class Endpoint(unittest.TestCase):
    def post(self, summarise):
        srv = make_server("127.0.0.1", 0, tempfile.mkdtemp(), summarise=summarise)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        req = urllib.request.Request("http://127.0.0.1:%d/api/insight" % srv.server_address[1], data=b"{}", method="POST")
        with urllib.request.urlopen(req) as r:
            return json.load(r)

    def test_off(self):
        out = self.post(None)
        self.assertFalse(out["ok"])
        self.assertEqual(out["error"], "The summary is not switched on.")

    def test_fake_summariser(self):
        out = self.post(lambda events, cfg: {"summary": "Hi.", "suggestion": "", "model": "m", "ms": 5})
        self.assertEqual((out["ok"], out["summary"]), (True, "Hi."))


if __name__ == "__main__":
    unittest.main()
