import json
import time
import urllib.request

from hub import keys


def decide(event, recent, config, ask_model=None):
    """Return {"action": "held" | "text" | "call", "reason": str}. Rules 1-3 are final."""
    rules = config.get("rules", {})
    threshold = rules.get("threshold", 0.8)
    urgent = rules.get("urgent", ["hurt"])
    repeat_seconds = rules.get("repeat_seconds", 20)
    gesture, conf = event["gesture"], event.get("confidence")

    if isinstance(conf, (int, float)) and conf < threshold:
        return {"action": "held", "reason": "The match was weak (%d%%), so nothing was sent." % round(conf * 100)}
    if gesture not in urgent:
        for r in recent:
            if (r["gesture"] == gesture and r["action"] in ("text", "call")
                    and event["time"] - r["time"] < repeat_seconds):
                return {"action": "held", "reason": "This is a repeat of what was just sent, so nothing new was sent."}
    if gesture in urgent:
        return {"action": "call", "reason": "This one is urgent, so a voice message was sent."}

    if ask_model:
        try:
            answer = ask_model(event, recent, config)
        except Exception:
            answer = None
        if answer in ("text", "call", "held"):
            return {"action": answer, "reason": "Chosen by the decision model."}
    return {"action": "text", "reason": "A text message was sent."}


# shortcut: Gemini REST shape written from memory and not run against the live API; verify with a real key before relying on it.
def gemini_ask(event, recent, config):
    key = keys.get("GEMINI_API_KEY")
    if not key:
        return None
    model = keys.get("GEMINI_MODEL") or "gemini-2.5-flash"
    now = event["time"]
    past = ", ".join("%s %ds ago" % (r["gesture"], now - r["time"]) for r in recent[:5]) or "none"
    prompt = (
        "A child who cannot speak made a wrist gesture. Decide whether to send a parent a text, "
        "an urgent voice message (call), or hold it back as a likely false positive. "
        "Gesture: %s. Confidence: %s. Local hour: %d. Recent: %s. "
        "Answer text, call or held." % (event["gesture"], event.get("confidence"), time.localtime(now).tm_hour, past)
    )
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {"action": {"type": "STRING", "enum": ["text", "call", "held"]}},
                "required": ["action"],
            },
        },
    }
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % model,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
    )
    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.load(resp)
        return json.loads(data["candidates"][0]["content"]["parts"][0]["text"])["action"]
    except urllib.error.HTTPError as e:
        print("gemini_ask failed: HTTP %d" % e.code)
    except Exception as e:
        print("gemini_ask failed: %s" % type(e).__name__)
    return None
