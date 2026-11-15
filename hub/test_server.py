import http.client, json, tempfile, threading, unittest
from pathlib import Path
from unittest import mock

from hub import app as server

server.Handler.log_message = lambda *a: None


class HubCase(unittest.TestCase):
    token = ""

    def start(self, data):
        srv = server.make_server("127.0.0.1", 0, data, self.token)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close()))
        return srv.server_address[1]

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data = tmp.name
        self.port = self.start(self.data)

    def call(self, method, path, body=None, headers=None, port=None):
        if body is not None and not isinstance(body, (str, bytes)):
            body = json.dumps(body)
        c = http.client.HTTPConnection("127.0.0.1", port or self.port, timeout=5)
        c.request(method, path, body, headers or {})
        r = c.getresponse()
        raw = r.read()
        c.close()
        try:
            return r.status, json.loads(raw)
        except ValueError:
            return r.status, raw

    def state(self):
        return self.call("GET", "/api/state")[1]


class Gestures(HubCase):
    def test_valid_post_is_first_in_state(self):
        self.call("POST", "/gesture", {"gesture": "milk"})
        status, body = self.call("POST", "/gesture", {"gesture": "water", "confidence": 0.9, "time": 1700000000})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["event"]["text"], server.DEFAULT_CONFIG["phrases"]["water"])
        self.assertEqual(body["event"]["delivery"], "logged")
        events = self.state()["events"]
        self.assertEqual(events[0], body["event"])
        self.assertEqual(events[0]["time"], 1700000000.0)
        self.assertGreater(events[0]["id"], events[1]["id"])

    def test_unknown_gesture_text(self):
        self.assertEqual(self.call("POST", "/gesture", {"gesture": "x"})[1]["event"]["text"], "Gesture: x")

    def test_bad_requests_are_400(self):
        for body in ("{not json", {"confidence": 1}, {"gesture": ""}, {"gesture": "a" * 41},
                     {"gesture": "x", "confidence": "high"}, {"gesture": "x", "time": True}, "[1]"):
            status, resp = self.call("POST", "/gesture", body)
            self.assertEqual(status, 400, body)
            self.assertFalse(resp["ok"])
            self.assertIsInstance(resp["error"], str)
        self.assertEqual(self.state()["events"], [])

    def test_oversized_body_is_413(self):
        self.assertEqual(self.call("POST", "/gesture", {"gesture": "x", "pad": "a" * 5000})[0], 413)

    def test_log_survives_restart(self):
        self.call("POST", "/gesture", {"gesture": "break"})
        with open(Path(self.data) / "log.jsonl", "a") as f:
            f.write("corrupt line\n")
        port = self.start(self.data)
        self.assertEqual(self.call("GET", "/api/state", port=port)[1]["events"][0]["gesture"], "break")
        self.assertEqual(self.call("POST", "/gesture", {"gesture": "x"}, port=port)[1]["event"]["id"], 2)


class Token(HubCase):
    token = "s3cret"

    def test_token_required(self):
        self.assertEqual(self.call("POST", "/gesture", {"gesture": "x"})[0], 401)
        self.assertEqual(self.call("POST", "/gesture", {"gesture": "x"}, {"X-Epsilon-Token": "nope"})[0], 401)
        self.assertEqual(self.call("POST", "/gesture", {"gesture": "x"}, {"X-Epsilon-Token": "s3cret"})[0], 200)
        self.assertEqual(len(self.state()["events"]), 1)

    def test_spoken_sentence_is_sent_as_it_is(self):
        status, body = self.call("POST", "/gesture?k=s3cret", {"gesture": "spoken", "text": " I am cold. ", "via": "voice"})
        self.assertEqual((status, body["event"]["text"], body["event"]["action"]), (200, "I am cold.", "text"))
        self.assertEqual(self.call("POST", "/gesture?k=s3cret", {"gesture": "spoken", "text": "", "via": "voice"})[0], 400)
        # free text is only honoured for confirmed speech: any other source still needs a known word
        e = self.call("POST", "/gesture?k=s3cret", {"gesture": "spoken", "text": "hello", "via": "gesture"})[1]["event"]
        self.assertEqual(e["action"], "held")

    def test_band_server_forward_shape(self):
        # what hub/server.py --forward posts: the word's id, milliseconds, and the token only in the address
        sent = {"id": "help", "label": "Help", "phrase": "I need help!", "urgent": True, "via": "gesture",
                "time": 1794700000000, "seq": 1}
        self.assertEqual(self.call("POST", "/gesture?k=nope", sent)[0], 401)
        status, body = self.call("POST", "/gesture?k=s3cret", sent)
        self.assertEqual(status, 200)
        e = body["event"]
        self.assertEqual((e["gesture"], e["action"], e["time"]), ("help", "call", 1794700000.0))


class Static(HubCase):
    def test_static_is_confined(self):
        for path in ("/static/../server.py", "/static/.env", "/static/%2e%2e%2fserver.py", "/static/a%5Cb.css",
                     "/static/", "/static/notes.txt"):
            self.assertEqual(self.call("GET", path)[0], 404, path)
        web = tempfile.TemporaryDirectory()
        self.addCleanup(web.cleanup)
        (Path(web.name) / "a.css").write_text("body{}")
        (Path(web.name) / "notes.txt").write_text("hi")
        with mock.patch.object(server, "WEB", Path(web.name)):
            self.assertEqual(self.call("GET", "/static/a.css")[0], 200)
            self.assertEqual(self.call("GET", "/static/notes.txt")[0], 404)  # unlisted type
            self.assertEqual(self.call("GET", "/")[0], 404)  # no index.html in the temp dir

    def test_content_type(self):
        web = tempfile.TemporaryDirectory()
        self.addCleanup(web.cleanup)
        (Path(web.name) / "index.html").write_text("<p>hi</p>")
        with mock.patch.object(server, "WEB", Path(web.name)):
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            c.request("GET", "/")
            r = c.getresponse()
            self.assertEqual((r.status, r.getheader("Content-Type")), (200, "text/html; charset=utf-8"))
            c.close()


class Live(HubCase):
    def test_sse_client_receives_event(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/events")
        r = c.getresponse()
        self.assertEqual(r.getheader("Content-Type"), "text/event-stream")
        self.call("POST", "/gesture", {"gesture": "help"})
        line = r.readline().decode()
        c.close()
        self.assertTrue(line.startswith("data: "))
        self.assertEqual(json.loads(line[6:])["text"], server.DEFAULT_CONFIG["phrases"]["help"])

    def test_config_changes_next_event(self):
        cfg = {"child": "Sam", "contact": "Mum", "phrases": {"water": "Water please, Mum."}}
        status, saved = self.call("POST", "/api/config", cfg)
        self.assertEqual((status, saved), (200, cfg))
        event = self.call("POST", "/gesture", {"gesture": "water"})[1]["event"]
        self.assertEqual((event["text"], event["to"]), ("Water please, Mum.", "Mum"))
        self.assertEqual(self.state()["config"], cfg)
        self.assertEqual(json.loads((Path(self.data) / "config.json").read_text()), cfg)
        port = self.start(self.data)  # saved config is reloaded
        self.assertEqual(self.call("GET", "/api/state", port=port)[1]["config"], cfg)

    def test_bad_config_is_400(self):
        for cfg in ({"child": "x" * 41, "contact": "", "phrases": {}}, {"child": "", "contact": 5, "phrases": {}},
                    {"child": "", "contact": "", "phrases": {"a": "b" * 121}},
                    {"child": "", "contact": "", "phrases": {str(i): "x" for i in range(21)}}, {"child": ""}):
            self.assertEqual(self.call("POST", "/api/config", cfg)[0], 400, cfg)
        self.assertEqual(self.state()["config"], server.DEFAULT_CONFIG)


if __name__ == "__main__":
    unittest.main()
