"""Epsilon hub: gesture JSON in, parent message out, pushed live to the dashboard. Standard library only."""
import hmac, json, os, queue, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from hub.decide import decide, gemini_ask
from hub.voice import speak

WEB = Path(__file__).resolve().parent / "web"
IMESSAGE = Path(__file__).resolve().parent.parent / "imessage"
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
         ".png": "image/png", ".woff2": "font/woff2", ".mp3": "audio/mpeg"}
# one word list for the band page (hub/server.py) and this app, so the two cannot drift apart
WORDS = json.loads((Path(__file__).resolve().parent / "messages.json").read_text(encoding="utf-8"))
DEFAULT_CONFIG = {"child": "", "contact": "", "phrases": {w["id"]: w["phrase"] for w in WORDS}}
URGENT = [w["id"] for w in WORDS if w.get("urgent")]
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
KEEPALIVE = 15


class Bad(Exception):
    """args: (http status, one plain sentence)"""


def notify(event, config):
    print("epsilon: #%d %s -> %s %s" % (event["id"], event["gesture"], event["action"], event["delivery"]), flush=True)


def imessage(to, text):
    """True if the Bun sender in imessage/ accepted the text. Off unless EPSILON_IMESSAGE=1."""
    if "@" not in to:  # a phone number as a parent types it: "+1 (415) 555-0100" -> "+14155550100"
        to = "".join(ch for ch in to if ch.isdigit() or ch == "+")
    try:
        r = subprocess.run(["bun", "src/send.ts", to, text], cwd=IMESSAGE, timeout=25,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except (OSError, subprocess.TimeoutExpired) as e:
        print("epsilon: iMessage not sent: %s" % type(e).__name__, flush=True)
        return False
    if r.returncode:
        print("epsilon: iMessage not sent: %s" % r.stderr.decode(errors="replace").strip()[-300:], flush=True)
    return r.returncode == 0


def num(x):  # also rejects bool, NaN and infinity
    return isinstance(x, (int, float)) and not isinstance(x, bool) and abs(x) < 1e15


def parse_obj(raw):
    try:
        obj = json.loads(raw)
    except ValueError:
        raise Bad(400, "Body is not valid JSON.")
    if not isinstance(obj, dict):
        raise Bad(400, "Body must be a JSON object.")
    return obj


def clean_config(b):
    child, contact, phrases = b.get("child"), b.get("contact"), b.get("phrases")
    if not isinstance(child, str) or len(child) > 40:
        raise Bad(400, "child must be text of at most 40 characters.")
    if not isinstance(contact, str) or len(contact) > 60:
        raise Bad(400, "contact must be text of at most 60 characters.")
    if not isinstance(phrases, dict) or len(phrases) > 20:
        raise Bad(400, "phrases must be an object with at most 20 entries.")
    for k, v in phrases.items():
        if not 0 < len(k) <= 40 or not isinstance(v, str) or len(v) > 120:
            raise Bad(400, "Each phrase needs a gesture name of 1 to 40 characters and text of at most 120.")
    out = {"child": child, "contact": contact, "phrases": dict(phrases)}
    th = (b.get("rules") or {}).get("threshold") if isinstance(b.get("rules") or {}, dict) else None
    if th is not None:
        if not num(th) or not 0 <= th <= 1:
            raise Bad(400, "rules.threshold must be a number from 0 to 1.")
        out["rules"] = {"threshold": th}
    return out


def make_server(host, port, data, token="", ask_model=None, speak=None, send=None):
    s = ThreadingHTTPServer((host, port), Handler)
    s.data, s.token, s.lock, s.listeners, s.events = Path(data), token, threading.Lock(), [], []
    s.ask_model, s.speak, s.send = ask_model, speak, send  # None in tests, so they never touch the network
    s.data.mkdir(parents=True, exist_ok=True)
    try:
        s.config = clean_config(json.loads((s.data / "config.json").read_text(encoding="utf-8")))
    except (OSError, ValueError, Bad, AttributeError):
        s.config = json.loads(json.dumps(DEFAULT_CONFIG))
    log = s.data / "log.jsonl"
    if log.exists():
        text = log.read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if isinstance(e, dict) and isinstance(e.get("id"), int):
                s.events.append(e)
        if text and not text.endswith("\n"):  # a crash left a half line; do not glue the next event onto it
            with open(log, "a", encoding="utf-8") as f:
                f.write("\n")
    s.next_id = max([e["id"] for e in s.events], default=0) + 1
    return s


class Handler(BaseHTTPRequestHandler):
    timeout = 10  # a stalled client must not hold a thread forever

    def reply(self, code, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit):
        try:
            n = int(self.headers.get("Content-Length", ""))
        except ValueError:
            n = -1
        if n < 0:
            raise Bad(400, "A Content-Length header is required.")
        if n > limit:
            self.rfile.read(min(n, 1 << 20))  # drain so the client sees our reply, not a reset
            raise Bad(413, "Body is too large.")
        return self.rfile.read(n)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def has_key(self):
        # the band server's --forward and the pages cannot set headers, so the token may also come as ?k=
        given = self.headers.get("X-Epsilon-Token") or parse_qs(urlsplit(self.path).query).get("k", [""])[0]
        return bool(self.server.token) and hmac.compare_digest(given.encode(), self.server.token.encode())

    def route(self, method):
        path, s = urlsplit(self.path).path, self.server
        try:
            # on a hosted hub the message list is private: reading it needs the key too
            if path in ("/events", "/api/state") and s.token and not (
                    self.has_key() or self.client_address[0] in LOOPBACK):
                raise Bad(401, "Open this page with its key: add ?k=... to the address.")
            if method == "GET" and path == "/events":
                return self.stream()
            if method == "GET" and path == "/api/state":
                with s.lock:
                    return self.reply(200, {"config": s.config, "events": s.events[-100:][::-1]})
            if method == "GET" and path in ("/", "/app"):
                return self.static("index.html" if path == "/" else "app.html")
            if method == "GET" and path.startswith("/static/"):
                return self.static(unquote(path[8:]))
            if method == "GET" and path.startswith("/audio/"):
                return self.static(unquote(path[7:]), s.data / "audio")
            if method == "POST" and path == "/gesture":
                return self.gesture()
            if method == "POST" and path == "/api/config":
                return self.config()
            raise Bad(404, "Not found.")
        except Bad as e:
            self.reply(e.args[0], {"ok": False, "error": e.args[1]})
        except OSError:
            self.reply(500, {"ok": False, "error": "The hub could not save that."})

    def static(self, name, folder=None):
        f = (folder or WEB) / name
        ctype = TYPES.get(f.suffix)
        if "/" in name or "\\" in name or "\0" in name or name.startswith(".") or not ctype or not f.is_file():
            raise Bad(404, "Not found.")
        self.reply(200, f.read_bytes(), ctype)

    def gesture(self):
        s, raw = self.server, self.read_body(4096)
        if s.token and not self.has_key():
            raise Bad(401, "Missing or wrong token (X-Epsilon-Token header, or ?k= in the address).")
        b = parse_obj(raw)
        # the band server forwards {"id": ..., "time": <milliseconds>}; plain clients send {"gesture": ...}
        g, c, t = b.get("gesture") or b.get("id"), b.get("confidence"), b.get("time")
        if num(t) and t > 1e11:
            t = t / 1000
        if not isinstance(g, str) or not 1 <= len(g) <= 40:
            raise Bad(400, "gesture must be text of 1 to 40 characters.")
        if c is not None and not num(c):
            raise Bad(400, "confidence must be a number.")
        if t is not None and not num(t):
            raise Bad(400, "time must be epoch seconds as a number.")
        with s.lock:
            cfg, recent = s.config, [e for e in s.events[::-1][:20] if "action" in e]
        event = {"time": float(time.time() if t is None else t), "gesture": g, "confidence": c,
                 "to": cfg["contact"], "text": cfg["phrases"].get(g, "Gesture: " + g), "delivery": "logged",
                 "audio": None}
        # decided outside the lock: the model and the voice call the network
        event.update(decide(event, recent, dict(cfg, rules={"urgent": URGENT, **cfg.get("rules", {})}), s.ask_model))
        if event["action"] == "call" and s.speak:
            name = "%d.mp3" % (time.time() * 1000)
            if s.speak("A message from %s: %s" % (cfg["child"] or "your child", event["text"]), s.data / "audio" / name):
                event["audio"] = "/audio/" + name
        if event["action"] != "held" and s.send and event["to"]:
            event["delivery"] = "sent" if s.send(event["to"], event["text"]) else "failed"
        with s.lock:
            event = dict(event, id=s.next_id)
            line = json.dumps(event)
            with open(s.data / "log.jsonl", "a", encoding="utf-8") as f:
                f.write(line + "\n")
            s.next_id += 1
            s.events.append(event)
            notify(event, cfg)
            for q in s.listeners:
                try:
                    q.put_nowait(line)
                except queue.Full:
                    pass  # a stuck dashboard drops events rather than slowing the hub
        self.reply(200, {"ok": True, "event": event})

    def config(self):
        s, raw = self.server, self.read_body(16384)
        if self.client_address[0] not in LOOPBACK and not self.has_key():
            raise Bad(403, "Settings can only be changed from the hub computer, or with the key.")
        cfg = clean_config(parse_obj(raw))
        with s.lock:
            tmp = s.data / "config.json.tmp"
            tmp.write_text(json.dumps(cfg), encoding="utf-8")
            os.replace(tmp, s.data / "config.json")
            s.config = cfg
        self.reply(200, cfg)

    def stream(self):
        s, q = self.server, queue.Queue(maxsize=100)
        with s.lock:
            s.listeners.append(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            while True:
                try:
                    msg = "data: %s\n\n" % q.get(timeout=KEEPALIVE)
                except queue.Empty:
                    msg = ": keepalive\n\n"
                self.wfile.write(msg.encode())
        except OSError:
            pass  # client went away
        finally:
            with s.lock:
                s.listeners.remove(q)


def main():
    host, port = os.environ.get("EPSILON_HOST", "127.0.0.1"), int(os.environ.get("EPSILON_PORT") or os.environ.get("PORT") or 8787)  # PORT: set by Railway
    data = os.environ.get("EPSILON_DATA") or Path(__file__).resolve().parent.parent / "data"
    srv = make_server(host, port, data, os.environ.get("EPSILON_TOKEN", ""), gemini_ask, speak,
                      imessage if os.environ.get("EPSILON_IMESSAGE") == "1" else None)
    print("Epsilon hub listening on http://%s:%d" % srv.server_address[:2], flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
