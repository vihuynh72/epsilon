# Epsilon

A wristband that lets a non-speaking autistic child ask for what they need. The child makes a wrist gesture they were taught. Their parent gets it as a text message, or as an urgent voice message when it matters.

Built in one day at VexoHacks (14 November 2026) on the Vexo Open event band, by Vi, Arun, and Zach.

**This is a prototype. It has not been tested with autistic users. It does not read minds: the wearer's own gesture is the only thing that sends a message.**

## How it works

```
band --Bluetooth--> band page (Chrome)        hub/sources/band/, hub/server.py
                      teach a gesture, recognise it
                          |  one word, as JSON
                          v
                    guardian app (Python)      hub/app.py, hub/decide.py, hub/voice.py
                      decide: text, urgent voice message, or hold back
                          |
          +---------------+----------------+
          v               v                v
   iMessage text    voice message     Messages page (live log)
   (Photon)         (ElevenLabs)      hub/web/
```

1. **Teach.** The wearer shows the band each gesture a few times. Every wearer has their own.
2. **Recognise.** The band page matches a new movement against the taught examples and sends one word (water, food, parents, sleep, help).
3. **Decide.** A decision model (Gemini) looks at the word, how sure the match was, the time, and recent messages. It chooses to text, to send an urgent voice message, or to hold the message back. One rule is fixed: an urgent word is never held back. If the model is unavailable, simple rules decide.
4. **Deliver.** The parent gets an iMessage with a sentence the family wrote ("I want water, please."). Urgent words also arrive as a voice message.
5. **Show.** Every gesture, sent or held, appears at once on the Messages page with the reason.

Holding back a doubtful match is the main safety feature. A false message puts words in someone's mouth.

## Run it

Python 3.9 or newer. No packages to install for the app. Chrome or Edge for the band page.

```
python3 -m hub.app                                                    # the guardian app, http://127.0.0.1:8787
python3 hub/server.py --forward http://127.0.0.1:8787/gesture         # the band page, http://localhost:8000
```

Try it with no band:

```
curl -X POST http://127.0.0.1:8787/gesture -H 'Content-Type: application/json' -d '{"gesture":"water","confidence":0.9}'
```

Tests:

```
python3 -m unittest hub.test_server hub.test_decide
node --test hub/test/gestures.test.mjs
```

Optional keys go in a local `.env` (see `.env.example`): `ELEVENLABS_API_KEY` for the voice, `GEMINI_API_KEY` for the decision model. Texting needs [Bun](https://bun.sh), a Photon Spectrum project in `imessage/.env`, and `EPSILON_IMESSAGE=1`. Without keys the app still runs and logs every message.

## What works today, honestly

| Part | State |
|---|---|
| Guardian app, decision rules, live Messages page | Works. Automated tests pass. |
| Band page sending words to the app | Works with test words sent through the band server. |
| iMessage text to a parent's phone | Works. Sent real texts during the event. |
| Urgent voice message (ElevenLabs) | Works. Recorded and sent during the event. |
| Gemini decision | Written. Not yet run with a working key. |
| Gesture accuracy on a real wrist | Not measured. |
| Tested with autistic users | No. |

## Layout

| Path | What it is |
|---|---|
| `hub/app.py`, `hub/decide.py`, `hub/voice.py` | The guardian app: receive, decide, speak |
| `hub/web/` | Landing page and the parent's Messages page |
| `hub/server.py`, `hub/sources/band/` | The band page and its send server |
| `hub/messages.json` | The words and sentences. Both halves read this one file |
| `imessage/` | The iMessage sender (Photon Spectrum, Bun) |
| `vexo-open-kit/` | The Vexo Open kit (MIT), unmodified |
| `docs/PLAN.md` | How the parts join, and what is still unverified |
| `docs/DEVPOST.md` | The project description for the submission |
| `docs/audioidea436.md` | Next idea: understanding a wearer's own sounds |

## Rules we hold to

- No keys, tokens, or recordings in git.
- Nothing is stored on the band. Its storage is not private.
- Stimming is never flagged, counted, or commented on.
- This adds to the tablet or cards a person already uses. It never replaces them.
- The wearer can always stay silent. Nothing sends a message for them.
