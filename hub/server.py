#!/usr/bin/env python3
"""Epsilon send server: the hand-off point between the band and the guardian's app.

    python3 hub/server.py            # in the repo folder; no packages to install

- The band page (this laptop only): http://localhost:8000/  -> hub/sources/band/
  It reads band 44 in Chrome, recognises the gesture and POSTs the word here.
- The guardian's app reads the words from here. The contract is in hub/README.md:
    GET  /api/messages?k=KEY   every word so far (JSON)
    GET  /api/events?k=KEY     live: server-sent events "history", "message", "ack"
    POST /api/ack?k=KEY        the guardian answers; the band's light glows green
  Or push: `--forward URL` POSTs every word as JSON to the app at URL, but only while the
  band page's "Send to the guardian app" switch is on.
  KEY is kept in data/guardian-token so it stays the same across restarts. Delete that
  file to make a new one (the old one stops working).

Other computers on the Wi-Fi reach only those three, and only with the key. Every file
(the kit, the band page) is served to this laptop only. `--local` keeps everything here.
"""
import argparse
import json
import mimetypes
import queue
import secrets
import socket
import sys
import threading
import time
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent          # the repo folder
HUB = ROOT / "hub"
LAPTOP_ONLY = [HUB, ROOT / "vexo-open-kit"]             # served to this laptop only
TOKEN_FILE = ROOT / "data" / "guardian-token"
MESSAGES = {m["id"]: m for m in json.loads((HUB / "messages.json").read_text(encoding="utf-8"))}
REPLIES = {"coming": "On my way", "ok": "Got it", "wait": "Wait a minute"}
VIA = {"gesture", "taps", "button"}
KEYED = ("/api/events", "/api/messages", "/api/ack")     # open to other devices that have the key
MAX_BODY = 4096
MAX_RECORDING = 8 * 1024 * 1024                      # a raw recording from the page
RECORDINGS = ROOT / "data" / "recordings"              # gitignored, like all of data/

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")


class Feed:
    """The words sent so far (the last 50, in memory) and everyone listening for new ones."""

    def __init__(self):
        self.lock = threading.Lock()
        self.history = deque(maxlen=50)
        self.listeners = set()
        self.seq = 0

    def publish(self, kind, data):
        with self.lock:
            if kind == "message":
                self.seq += 1
                data["seq"] = self.seq
                self.history.append(data)
            listeners = list(self.listeners)
        for q in listeners:
            try:
                q.put_nowait((kind, data))
            except queue.Full:                      # a listener that stopped reading
                self.leave(q)
        return data

    def join(self):
        q = queue.Queue(maxsize=200)
        with self.lock:
            self.listeners.add(q)
            return q, list(self.history)

    def leave(self, q):
        with self.lock:
            self.listeners.discard(q)


FEED = Feed()
FORWARD = []                                            # URLs from --forward


def host_of(url):
    """Just the host, for showing on the page (the URL itself may hold the app's key)."""
    return urlsplit(url).netloc


def forward(data):
    """POST one word to every --forward URL, all at once; wait at most 5 s. Returns what each said."""
    results = {}
    def go(url):
        request = urllib.request.Request(url, data=json.dumps(data).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "User-Agent": "epsilon-hub"})
        try:
            with urllib.request.urlopen(request, timeout=5) as answer:
                results[url] = {"to": host_of(url), "ok": 200 <= answer.status < 300, "status": answer.status}
        except Exception as e:                           # the app is down, slow or unreachable: say so, keep going
            results[url] = {"to": host_of(url), "ok": False, "error": str(getattr(e, "reason", e))[:120]}
        r = results[url]
        print(f"          {'forwarded' if r['ok'] else 'NOT forwarded'} to {r['to']}: {r.get('status') or r.get('error')}", flush=True)
    threads = [threading.Thread(target=go, args=(url,), daemon=True) for url in FORWARD]
    for t in threads:
        t.start()
    for t in threads:
        t.join(6)
    return [results.get(url, {"to": host_of(url), "ok": False, "error": "no answer"}) for url in FORWARD]


def load_token():
    try:
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if len(token) >= 12:
            return token
    except OSError:
        pass
    token = secrets.token_urlsafe(12)
    TOKEN_FILE.parent.mkdir(exist_ok=True)
    TOKEN_FILE.write_text(token + "\n", encoding="utf-8")
    TOKEN_FILE.chmod(0o600)
    return token


def lan_address():
    """This laptop's address on the Wi-Fi. A UDP connect sends nothing; it only picks the route."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


class Handler(BaseHTTPRequestHandler):
    server_version = "Epsilon"
    cors = False                                   # set for a keyed request: any web app may read it

    def log_message(self, fmt, *args):             # quiet: the server prints its own lines
        pass

    # --- who is asking ---------------------------------------------------------------
    def local(self):
        host = self.client_address[0]
        return host in ("127.0.0.1", "::1") or host.startswith("::ffff:127.")

    def has_key(self, query):
        return secrets.compare_digest(query.get("k", [""])[0], self.server.token)

    # --- answers ---------------------------------------------------------------------
    def send_bytes(self, code, body, kind):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, code, data):
        self.send_bytes(code, json.dumps(data).encode(), "application/json")

    def send_text(self, code, text):
        self.send_bytes(code, text.encode(), "text/plain; charset=utf-8")

    def redirect(self, where):
        self.send_response(302)
        self.send_header("Location", where)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_file(self, path, url_path):
        if path.is_dir():
            if not url_path.endswith("/"):        # relative imports need the trailing slash
                return self.redirect(url_path + "/")
            path = path / "index.html"
        if not path.is_file():
            return self.send_text(404, "Not found")
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if kind.startswith("text/") or kind in ("application/json", "text/javascript"):
            kind += "; charset=utf-8"
        self.send_bytes(200, path.read_bytes(), kind)

    def resolve_under(self, base, rel):
        """The file `rel` inside `base`, or None if it is outside it or a hidden file."""
        rel = unquote(rel).lstrip("/")
        if any(part.startswith(".") for part in rel.split("/") if part):
            return None
        target = (base / rel).resolve()
        return target if target == base or base in target.parents else None

    # --- GET -------------------------------------------------------------------------
    def do_GET(self):
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)

        if path in KEYED:
            self.cors = self.has_key(query)
            if not (self.local() or self.cors):
                return self.send_text(403, "Wrong or missing key (?k=...).")
            if path == "/api/messages":
                with FEED.lock:
                    return self.send_json(200, list(FEED.history))
            return self.stream()
        if not self.local():
            return self.send_text(404, "Not found")
        if path == "/":
            return self.redirect("/hub/sources/band/")
        if path == "/api/info":
            return self.send_json(200, {
                "feed_url": self.server.feed_url,
                "forward_to": [host_of(url) for url in FORWARD],
                "messages": list(MESSAGES.values()),
                "replies": REPLIES,
            })
        for base in LAPTOP_ONLY:
            prefix = "/" + base.relative_to(ROOT).as_posix()
            if path == prefix or path.startswith(prefix + "/"):
                target = self.resolve_under(base, path[len(prefix):])
                return self.send_file(target, path) if target else self.send_text(404, "Not found")
        return self.send_text(404, "Not found")

    do_HEAD = do_GET

    def do_OPTIONS(self):
        """CORS preflight: only for the keyed endpoints, and only with the key."""
        url = urlsplit(self.path)
        if url.path not in KEYED or not self.has_key(parse_qs(url.query)):
            return self.send_text(404, "Not found")
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def stream(self):
        """Server-sent events: first the history, then every new word and reply as it happens."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        if self.cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        q, history = FEED.join()
        try:
            self.event("history", history)
            while True:
                try:
                    kind, data = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": still here\n\n")
                    self.wfile.flush()
                    continue
                self.event(kind, data)
        except OSError:                            # the page closed or the phone went away
            pass
        finally:
            FEED.leave(q)

    def event(self, kind, data):
        self.wfile.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())
        self.wfile.flush()

    # --- POST ------------------------------------------------------------------------
    def save_recording(self):
        """POST /api/recording?name=calibration: raw band samples from the page, kept for tuning."""
        if self.headers.get("X-Epsilon") != "1":
            return self.send_text(400, "Bad request")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_RECORDING:
            return self.send_text(400, "Bad size")
        body = self.rfile.read(length)
        try:
            json.loads(body)
        except ValueError:
            return self.send_text(400, "Not JSON")
        name = "".join(c for c in parse_qs(urlsplit(self.path).query).get("name", ["recording"])[0] if c.isalnum() or c == "-")[:40] or "recording"
        RECORDINGS.mkdir(parents=True, exist_ok=True)
        path = RECORDINGS / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}.json"
        path.write_bytes(body)
        print(f"{time.strftime('%H:%M:%S')}  saved {path.relative_to(ROOT)} ({length // 1024} kB)", flush=True)
        return self.send_json(200, {"saved": str(path.relative_to(ROOT))})

    def read_json(self, keyed=False):
        # Without the key, the custom header is required. It makes a browser ask first (CORS
        # preflight), which this server only allows with the key: so another website open
        # on the laptop cannot post fake words.
        if "application/json" not in self.headers.get("Content-Type", ""):
            return None
        if not keyed and self.headers.get("X-Epsilon") != "1":
            return None
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if not 0 < length <= MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(length))
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def do_POST(self):
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        if path == "/api/recording" and self.local():
            return self.save_recording()
        self.cors = path in KEYED and self.has_key(query)
        body = self.read_json(keyed=self.cors)
        if body is None:
            return self.send_text(400, "Bad request")

        if path == "/api/message" and self.local():
            m = MESSAGES.get(body.get("id"))
            via = body.get("via")
            if m is None or via not in VIA:
                return self.send_text(400, "Unknown word")
            word = {**m, "via": via, "time": int(time.time() * 1000)}
            confidence = body.get("confidence")
            if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and 0 <= confidence <= 1:
                word["confidence"] = round(float(confidence), 3)   # 1 = sure; taps are 1
            sent = FEED.publish("message", word)
            note = f", confidence {word['confidence']:.2f}" if "confidence" in word else ""
            print(f"{time.strftime('%H:%M:%S')}  sent  {m['label']:<8} ({via}{note})", flush=True)
            # Forward only when the page says so (its "Send to the guardian app" switch): while
            # teaching and testing, words stay on this laptop.
            sent_out = forward(sent) if body.get("forward") is True and FORWARD else []
            if FORWARD and not sent_out:
                print("          (not forwarded: the page's switch is off)", flush=True)
            return self.send_json(200, {**sent, "forwarded": sent_out})

        if path == "/api/ack" and (self.local() or self.cors):
            reply = body.get("reply")
            seq = body.get("seq")
            if reply not in REPLIES or not isinstance(seq, int):
                return self.send_text(400, "Unknown reply")
            FEED.publish("ack", {"reply": reply, "text": REPLIES[reply], "seq": seq, "time": int(time.time() * 1000)})
            print(f"{time.strftime('%H:%M:%S')}  reply {REPLIES[reply]}", flush=True)
            return self.send_json(200, {"ok": True})

        return self.send_text(404, "Not found")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--local", action="store_true", help="only this laptop (no phone)")
    parser.add_argument("--forward", action="append", default=[], metavar="URL",
                        help="also POST every word as JSON to this URL (can be given more than once)")
    args = parser.parse_args()
    for url in args.forward:
        if not url.startswith(("http://", "https://")):
            sys.exit(f"--forward needs an http:// or https:// address, not {url!r}")
    FORWARD.extend(args.forward)

    host = "127.0.0.1" if args.local else "0.0.0.0"
    try:
        ThreadingHTTPServer.request_queue_size = 64   # Chrome opens many connections at once for the modules
        server = ThreadingHTTPServer((host, args.port), Handler)
    except OSError as e:
        sys.exit(f"Port {args.port} is busy ({e.strerror}). Try: python3 hub/server.py --port 8001")
    server.daemon_threads = True
    server.token = load_token()
    address = "127.0.0.1" if args.local else lan_address()
    server.feed_url = f"http://{address}:{args.port}/api/events?k={server.token}"

    print(f"Band page (this laptop, Chrome): http://localhost:{args.port}/")
    print(f"Feed for the guardian app:       {server.feed_url}")
    print(f"                                 (and /api/messages?k=... for the list so far)")
    for url in FORWARD:
        print(f"Every word is also POSTed to:    {url}")
    if not args.local:
        print("Nobody else on the Wi-Fi gets in without the key. Ctrl+C stops.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
