"""Decide what happens to one recognised gesture: hold it back, text the parent, or send an urgent voice message.

The decision model goes first and sees the whole picture. The fixed rules below are the fallback when the
model is missing, slow or wrong, plus one floor it cannot break: an urgent word is never held back.
"""
import json
import time
import urllib.error
import urllib.request

from hub import keys

ACTIONS = ("held", "text", "call")


def rules_of(config):
    r = config.get("rules", {})
    return r.get("threshold", 0.8), r.get("urgent", ["hurt"]), r.get("repeat_seconds", 20)


def decide(event, recent, config, ask_model=None):
    """Return {"action": "held" | "text" | "call", "reason": str, "by": "model" | "rules"}."""
    threshold, urgent, repeat_seconds = rules_of(config)
    gesture, conf = event["gesture"], event.get("confidence")

    if ask_model:
        try:
            answer = ask_model(event, recent, config)
        except Exception:
            answer = None
        if isinstance(answer, str):
            answer = (answer, "")
        if answer and answer[0] in ACTIONS:
            if gesture in urgent and answer[0] == "held":   # the one thing the model may not do
                return {"action": "call", "reason": "Urgent words are never held back.", "by": "rules"}
            return {"action": answer[0], "reason": answer[1] or "Chosen by the decision model.", "by": "model"}

    if isinstance(conf, (int, float)) and conf < threshold:
        reason = "The match was weak (%d%%), so nothing was sent." % round(conf * 100)
        return {"action": "held", "reason": reason, "by": "rules"}
    if gesture in urgent:
        return {"action": "call", "reason": "This one is urgent, so a voice message was sent.", "by": "rules"}
    for r in recent:
        if r["gesture"] == gesture and r["action"] in ("text", "call") and event["time"] - r["time"] < repeat_seconds:
            return {"action": "held", "reason": "This is a repeat of what was just sent, so nothing new was sent.",
                    "by": "rules"}
    return {"action": "text", "reason": "A text message was sent.", "by": "rules"}


PROMPT = """You decide what a communication aid does with one message from a non-speaking autistic child.
The child made a wrist gesture on a band. A recogniser matched it to a word. A wrong or needless message
alarms a parent and puts words in the child's mouth. A missed real message leaves the child unheard.

Choose one action:
- "text": send the parent a normal text. The usual choice for a clear, new request.
- "call": send an urgent voice message. For danger, pain or a call for help, or a need repeated many times with no answer.
- "held": send nothing. For a doubtful match, an accidental trigger, or the same word again moments after it was sent.

Facts:
- Word: "{gesture}" (urgent word: {urgent}). The sentence it sends: "{text}"
- Recogniser confidence: {confidence}. Below {threshold} is doubtful. "not given" means the recogniser has no
  score and has already accepted this match: treat it as a confident match, never as a reason to hold.
- How it was made: {via}
- Local time: {hour}:00
- Recent messages, newest first: {recent}

Give the action and one short plain sentence a parent can read explaining why."""


def gemini_ask(event, recent, config):
    """(action, reason) from Gemini, or None when there is no key, no credit, or no answer in time."""
    key = keys.get("GEMINI_API_KEY")
    if not key:
        return None
    model = keys.get("GEMINI_MODEL") or "gemini-flash-lite-latest"   # about 1 second per decision when measured
    threshold, urgent, _ = rules_of(config)
    now, conf = event["time"], event.get("confidence")
    past = "; ".join("%s (%s) %d seconds ago" % (r["gesture"], r["action"], now - r["time"]) for r in recent[:6])
    prompt = PROMPT.format(
        gesture=event["gesture"], urgent="yes" if event["gesture"] in urgent else "no", text=event.get("text", ""),
        confidence="not given" if conf is None else conf, threshold=threshold, via=event.get("via") or "gesture",
        hour=time.localtime(now).tm_hour, recent=past or "none")
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {"action": {"type": "STRING", "enum": list(ACTIONS)}, "reason": {"type": "STRING"}},
                "required": ["action", "reason"],
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
        out = json.loads(data["candidates"][0]["content"]["parts"][0]["text"])
        return out["action"], str(out.get("reason", ""))[:200]
    except urllib.error.HTTPError as e:
        print("gemini_ask failed: HTTP %d" % e.code, flush=True)
    except Exception as e:
        print("gemini_ask failed: %s" % type(e).__name__, flush=True)
    return None
