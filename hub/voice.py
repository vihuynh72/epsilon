import json
import os
import urllib.request

from hub import keys


def speak(text, out_path):
    """ElevenLabs text to speech saved as mp3. Returns True on success. Never prints key or body."""
    key = keys.get("ELEVENLABS_API_KEY")
    if not key:
        return False
    voice = keys.get("ELEVENLABS_VOICE") or "EXAVITQu4vr4xnSDxMaL"
    model = keys.get("ELEVENLABS_MODEL") or "eleven_flash_v2_5"
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/text-to-speech/%s?output_format=mp3_44100_128" % voice,
        data=json.dumps({"text": text[:300], "model_id": model}).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            status, audio = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        print("speak failed: HTTP %d" % e.code)
        return False
    except Exception as e:
        print("speak failed: %s" % type(e).__name__)
        return False
    if status != 200:
        print("speak failed: HTTP %d" % status)
        return False
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(audio)
    return True
