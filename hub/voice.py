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


TEACH_MODEL = "gemini-4-hydrogen"       # teaching: listens to a taught sound and writes it into the sound book
LISTEN_MODEL = "gemini-flash-latest"    # action: the fast model listens when Deepgram hears no words
WORD_MODEL = "gemini-flash-lite-latest"  # action: the fast decision model picks the word from Deepgram's text


def hear_words(audio, mime):
    """Deepgram: the words in one short recording, or "" (also when there is no key or no answer)."""
    import json
    key = keys.get("DEEPGRAM_API_KEY")
    if not key or not audio:
        return ""
    req = urllib.request.Request(  # mip_opt_out: Deepgram must not keep this sound to train its models
        "https://api.deepgram.com/v1/listen?model=nova-3&filler_words=true&mip_opt_out=true", data=audio,
        headers={"Authorization": "Token " + key, "Content-Type": mime})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return str(json.load(r)["results"]["channels"][0]["alternatives"][0]["transcript"])[:200].strip()
    except Exception as e:
        print("hear_words failed: %s" % type(e).__name__, flush=True)
        return ""


def pick_word(text, words, known=None):
    """The fast decision model: which of the family's words does this written-down speech mean?
    Returns {"word", "confidence", "heard"} or None."""
    import json
    key = keys.get("GEMINI_API_KEY")
    if not key or not text or not words:
        return None
    prompt = ("A speech-to-text service wrote this from a short recording of one person, who may speak unclearly: "
              "\"%s\". Which ONE of these words do they mean: %s? Answer \"unsure\" if it is not clearly one of "
              "them. Give your confidence from 0 to 1." % (text[:200], ", ".join(words)))
    if known:
        prompt += (" A carer has confirmed this person's own sounds before: %s. If the text matches one of those "
                   "sounds, answer that meaning." % "; ".join('"%s" means %s' % (k[0], k[1]) for k in known[:20]))
    body = {"contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "responseSchema": {
                "type": "OBJECT", "required": ["word", "confidence"], "properties": {
                    "word": {"type": "STRING", "enum": list(words) + ["unsure"]}, "confidence": {"type": "NUMBER"}}}}}
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % (keys.get("GEMINI_MODEL") or WORD_MODEL),
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            out = json.loads(json.load(r)["candidates"][0]["content"]["parts"][0]["text"])
        conf = out.get("confidence")
        return {"word": out["word"], "heard": text, "confidence": max(0.0, min(1.0, float(conf))) if isinstance(conf, (int, float)) else 0.0}
    except Exception as e:
        print("pick_word failed: %s" % type(e).__name__, flush=True)
        return None


def guess_word(audio, mime, words, known=None, model=None):
    """Ask Gemini to listen to one short recording and say which of the family's words it most likely is.
    For speech that is unclear or unusual. Returns {"word": one of words or "unsure", "confidence": 0..1,
    "heard": str} or None. The answer is only ever a suggestion: a person confirms it before anything is sent."""
    import base64
    import json
    key = keys.get("GEMINI_API_KEY")
    if not key or not audio or not words:
        return None
    model = model or keys.get("GEMINI_AUDIO_MODEL") or LISTEN_MODEL
    prompt = ("This is a short recording of one person trying to say ONE of these words: %s. "
              "They may speak unclearly, slowly, or pronounce it in an unusual way, for example only the vowels "
              "or only the first sound. Decide which word it most likely is. If it is silence, noise, or could "
              "be two of the words equally, or does not sound like one of the words or a sound a carer has "
              "confirmed, answer \"unsure\". Never guess. Give your confidence from 0 to 1, and write "
              "in `heard` roughly what it sounded like, spelled as it sounds." % ", ".join(words))
    if known:  # what this family has taught so far: the person's own sounds, confirmed by a carer
        prompt += (" This person has their own way of saying things. A carer has confirmed these before: %s. "
                   "If the recording sounds like one of these, answer that meaning, even if it is nothing like "
                   "the word itself." % "; ".join('a sound like "%s" means %s (confirmed %d times)' % k for k in known[:20]))
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
