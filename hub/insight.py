"""A plain summary of the last day of messages, written by Gemini 4. Called by POST /api/insight in hub/app.py.
The user asked: "how to use Gemini 4 in order to build the actual part of actually parsing data, making meaningful improvements".
Only time, word, outcome, score and how it was made are sent: never the child's name or the parent's contact."""
import json
import time
import urllib.error
import urllib.request

from hub import keys

PROMPT = """You are describing one day of messages for a parent. A child who cannot speak sends words with a wristband.
The table has one row per message: time, word, what happened (texted, emergency, or held back), match score, how it was made.

In "summary" write 2 or 3 short plain sentences: which words were sent, roughly when, how many were emergencies, how many were held back and the usual reason.
In "suggestion" give at most one practical tip about the tool itself (for example two words being confused, many weak matches for one word suggesting it be taught again, or a word asked for repeatedly at one time of day), or an empty string if nothing stands out.
Use only the table. Do not guess feelings, health, behaviour or causes. Do not diagnose. Do not mention anything other than the taught words.
Never present a held-back message as something the child said. Short sentences, no jargon.

Messages:
%s"""
HAPPENED = {"text": "texted", "call": "sent as an emergency", "held": "held back"}


def summarise(events, config, now=None):
    """{"summary", "suggestion", "model", "ms"}, or None when there is no key or no answer. config is unused: no private details go out."""
    now = time.time() if now is None else now
    recent = sorted((e for e in events if now - 86400 <= e.get("time", 0) <= now + 60), key=lambda e: e["time"])[-80:]
    if not recent:
        return {"summary": "No messages in the last day.", "suggestion": ""}
    key = keys.get("GEMINI_API_KEY")
    if not key:
        return None
    model = keys.get("GEMINI_INSIGHT_MODEL") or "gemini-4-hydrogen"
    rows = []
    for e in recent:
        c = e.get("confidence")
        what = HAPPENED.get(e.get("action"), str(e.get("action")))
        if e.get("action") == "held" and e.get("reason"):
            what += " (" + str(e["reason"])[:120] + ")"
        rows.append("%s | %s | %s | %s | %s" % (
            time.strftime("%H:%M", time.localtime(e["time"])), e.get("gesture"), what,
            "no score" if c is None else "%d%%" % round(c * 100), e.get("via") or "gesture"))
    body = {
        "contents": [{"parts": [{"text": PROMPT % "\n".join(rows)}]}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {"summary": {"type": "STRING"}, "suggestion": {"type": "STRING"}},
                "required": ["summary", "suggestion"],
            },
        },
    }
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % model,
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
        out = json.loads(data["candidates"][0]["content"]["parts"][0]["text"])
        return {"summary": str(out["summary"])[:600], "suggestion": str(out.get("suggestion", ""))[:300],
                "model": model, "ms": round((time.time() - started) * 1000)}
    except urllib.error.HTTPError as e:
        print("insight failed: HTTP %d" % e.code, flush=True)
    except Exception as e:
        print("insight failed: %s" % type(e).__name__, flush=True)
    return None
