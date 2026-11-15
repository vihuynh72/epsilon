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


# shortcut: written from Twilio's long-standing Calls API and never run (no Twilio account yet);
# place one test call before relying on it.
def ring(to, audio_url):
    """Phone `to` and play the recording at `audio_url` twice. True if Twilio accepted the call.
    Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (a Twilio number) in .env; without them, False."""
    import base64
    import urllib.parse
    sid, token, sender = keys.get("TWILIO_ACCOUNT_SID"), keys.get("TWILIO_AUTH_TOKEN"), keys.get("TWILIO_FROM")
    if not (sid and token and sender and to and audio_url.startswith("https://")):
        return False
    play = "<Play>%s</Play>" % audio_url.replace("&", "&amp;")
    form = urllib.parse.urlencode({"To": to, "From": sender,
                                   "Twiml": "<Response>%s<Pause length=\"1\"/>%s</Response>" % (play, play)}).encode()
    req = urllib.request.Request("https://api.twilio.com/2010-04-01/Accounts/%s/Calls.json" % sid, data=form,
                                 headers={"Authorization": "Basic " + base64.b64encode(("%s:%s" % (sid, token)).encode()).decode()})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status in (200, 201)
    except urllib.error.HTTPError as e:
        print("ring failed: HTTP %d" % e.code, flush=True)
    except Exception as e:
        print("ring failed: %s" % type(e).__name__, flush=True)
    return False


def guess_word(audio, mime, words):
    """Ask Gemini to listen to one short recording and say which of the family's words it most likely is.
    For speech that is unclear or unusual. Returns {"word": one of words or "unsure", "confidence": 0..1,
    "heard": str} or None. The answer is only ever a suggestion: a person confirms it before anything is sent."""
    import base64
    import json
    key = keys.get("GEMINI_API_KEY")
    if not key or not audio or not words:
        return None
    model = keys.get("GEMINI_AUDIO_MODEL") or "gemini-flash-latest"
    prompt = ("This is a short recording of one person trying to say ONE of these words: %s. "
              "They may speak unclearly, slowly, or pronounce it in an unusual way, for example only the vowels "
              "or only the first sound. Decide which word it most likely is. If it is silence, noise, or could "
              "be two of the words equally, answer \"unsure\". Give your confidence from 0 to 1, and write "
              "in `heard` roughly what it sounded like." % ", ".join(words))
    body = {"contents": [{"parts": [{"inline_data": {"mime_type": mime, "data": base64.b64encode(audio).decode()}},
                                    {"text": prompt}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "responseSchema": {
                "type": "OBJECT", "required": ["word", "confidence", "heard"], "properties": {
                    "word": {"type": "STRING", "enum": list(words) + ["unsure"]},
                    "confidence": {"type": "NUMBER"}, "heard": {"type": "STRING"}}}}}
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % model,
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            out = json.loads(json.load(r)["candidates"][0]["content"]["parts"][0]["text"])
        conf = out.get("confidence")
        return {"word": out["word"], "heard": str(out.get("heard", ""))[:120],
                "confidence": max(0.0, min(1.0, float(conf))) if isinstance(conf, (int, float)) else 0.0}
    except urllib.error.HTTPError as e:
        print("guess_word failed: HTTP %d" % e.code, flush=True)
    except Exception as e:
        print("guess_word failed: %s" % type(e).__name__, flush=True)
    return None
