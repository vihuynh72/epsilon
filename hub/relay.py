"""Text the parent for every message the cloud hub accepts.

Use when the band laptop cannot reach this laptop (event Wi-Fi blocks laptop-to-laptop traffic):
the band forwards to the cloud hub, and this relay, on the laptop that has the iMessage sender set up,
listens to the cloud hub and sends the texts.

    python3 -m hub.relay https://<cloud hub address> <key>

The phone number is the one saved in Set up on this laptop (data/config.json).
"""
import json
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from hub.app import imessage
from hub.voice import ring

DATA = Path(__file__).resolve().parent.parent / "data"


def contact():
    try:
        return json.loads((DATA / "config.json").read_text(encoding="utf-8")).get("contact", "")
    except (OSError, ValueError):
        return ""


def deliver(base, key, event):
    to = contact()
    if event.get("action") == "held" or not to:
        print("relay: #%s %s not sent (%s)" % (event.get("id"), event.get("gesture"),
                                               "held back" if to else "no phone number in Set up"), flush=True)
        return
    clip = None
    audio = event.get("audio") or ""
    if audio.startswith("/audio/"):  # the urgent recording lives on the cloud hub: fetch it to send as a voice message
        try:
            with urllib.request.urlopen("%s%s?k=%s" % (base, audio, key), timeout=15) as r:
                clip = Path(tempfile.gettempdir()) / ("epsilon-" + audio[7:])
                clip.write_bytes(r.read())
        except OSError as e:
            print("relay: could not fetch the recording (%s); sending the text only" % type(e).__name__, flush=True)
            clip = None
    if audio.startswith("/audio/") and base.startswith("https://"):  # a real phone call, when Twilio is set up
        number = "".join(ch for ch in to if ch.isdigit() or ch == "+")
        if ring(number, base + audio):
            print("relay: #%s phoning the parent" % event.get("id"), flush=True)
    ok = imessage(to, str(event.get("text", ""))[:300], clip)
    print("relay: #%s %s -> %s" % (event.get("id"), event.get("gesture"), "texted" if ok else "FAILED"), flush=True)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    base, key = sys.argv[1].rstrip("/"), sys.argv[2]
    while True:
        try:
            with urllib.request.urlopen("%s/events?k=%s" % (base, key), timeout=60) as stream:
                print("relay: listening to %s" % base, flush=True)
                for line in stream:
                    if line.startswith(b"data: "):
                        try:
                            deliver(base, key, json.loads(line[6:]))
                        except ValueError:
                            pass
        except KeyboardInterrupt:
            return
        except Exception as e:  # the link dropped or the hub restarted: wait and listen again
            print("relay: reconnecting (%s)" % type(e).__name__, flush=True)
            time.sleep(3)


if __name__ == "__main__":
    main()
