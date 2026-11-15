"""Text the parent for every message the cloud hub accepts.

Use when the band laptop cannot reach this laptop (event Wi-Fi blocks laptop-to-laptop traffic):
the band forwards to the cloud hub, and this relay, on the laptop that has the iMessage sender set up,
listens to the cloud hub and sends the texts.

    python3 -m hub.relay https://<cloud hub address> <key>

The phone number is the one saved in Set up on this laptop (data/config.json).
"""
import json
import subprocess
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


def cloud_contact(base, key):
    """The phone number saved in Set up on the cloud hub, so whoever sets it up there gets the texts."""
    try:
        with urllib.request.urlopen("%s/api/state?k=%s" % (base, key), timeout=8) as r:
            return json.load(r)["config"].get("contact", "")
    except Exception:
        return ""


KNOWN = set()


def register(number):
    """A shared Photon line only texts people registered on the project: add a new number once.
    The person must still send one iMessage to their assigned Epsilon number before texts can reach them."""
    if number in KNOWN:
        return
    KNOWN.add(number)
    env = (Path(__file__).resolve().parent.parent / "imessage" / ".env")
    try:
        project = next(l.split("=", 1)[1].strip() for l in env.read_text().splitlines() if l.startswith("PROJECT_ID="))
        users = json.loads(subprocess.run(["npx", "-y", "@photon-ai/cli@legacy", "spectrum", "users", "list", "--project", project, "--json"],
                                          capture_output=True, timeout=45).stdout)
        users = users if isinstance(users, list) else next((v for v in users.values() if isinstance(v, list)), [])
        mine = next((u for u in users if u.get("phoneNumber") == number), None)
        if not mine:
            subprocess.run(["npx", "-y", "@photon-ai/cli@legacy", "spectrum", "users", "add", "--phone", number, "--project", project],
                           capture_output=True, timeout=45)
            print("relay: registered the number ending %s with Photon. They must now send one iMessage to their "
                  "Epsilon number (shown under Users in the Photon dashboard) before texts can reach them." % number[-2:], flush=True)
    except Exception as e:
        print("relay: could not register the number ending %s (%s)" % (number[-2:], type(e).__name__), flush=True)


def deliver(base, key, event):
    to = "".join(ch for ch in cloud_contact(base, key) if ch.isdigit() or ch == "+") or contact()
    if to and event.get("action") != "held":
        register(to)
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
    words = str(event.get("text", ""))[:300] + ("\n" + str(event["note"])[:200] if event.get("note") else "")
    ok = imessage(to, words, clip)
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
