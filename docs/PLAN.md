# Epsilon team plan

Status: plan v2, 2026-11-14 at 16:00. Submission is at 18:00. The idea and its reasons are in [IDEA.md](IDEA.md).

## The product in one line

A child who does not speak makes a taught wrist gesture. Their parent gets it as a plain message, or as an urgent voice message when it matters. A doubtful match is held back and nobody is alarmed.

The wearer is an autistic person. Every choice is made for them first.

## Who does what

| Person | Domain | Ends at |
|---|---|---|
| Zach | The band and gesture recognition | Sends one JSON message per recognised gesture |
| Vi and Arun | Everything after the gesture: the hub, the decision, the message, the pages, the demo | Starts at that JSON message |

Vi and Arun do not touch gesture code. Zach does not touch the hub.

## Zach: how to join your band to the app

Your band server (`hub/server.py`) already has what is needed: the `--forward` option. The app (`hub/app.py`) accepts exactly what it posts. Checked on 2026-11-14: words sent through your server reached the app and were texted to Vi's phone.

1. Get the code: `git pull origin main` (it holds your branch and the app).
2. Pick where the words go:

| Where | Start your server like this | What happens |
|---|---|---|
| The app on Vi's laptop (same Wi-Fi) | `python3 hub/server.py --forward "http://<Vi's laptop address>:8787/gesture?k=KEY"` | Shown on the Messages page and texted to the parent's phone |
| The app on Railway (anywhere) | `python3 hub/server.py --forward "https://epsilon-production-a4d0fa9e.up.railway.app/gesture?k=KEY"` | Shown on the Messages page. No text yet |
| Everything on one laptop | `python3 -m hub.app` in one terminal, `python3 hub/server.py --forward http://127.0.0.1:8787/gesture` in another | Both |

Ask Vi for `KEY`. It is not in this repo on purpose.

- The word ids come from `hub/messages.json`. Both halves read that one file, so add or rename words there.
- A word marked `"urgent": true` becomes a text plus a voice message.
- Your server sends no confidence number, so the app's "hold back weak matches" rule never fires for band words. If your recogniser has a score, add `"confidence": 0.0 to 1.0` to what you forward and weak matches will be held.

## The one contract between the two halves

Anything else can also post to the hub directly:

```
POST http://<hub address>:8787/gesture
Content-Type: application/json

{"gesture": "water", "confidence": 0.93}
```

- `gesture`: a name, 1 to 40 characters. It must match a word id in `hub/messages.json` (water, food, parents, sleep, help to start).
- `confidence`: optional, a number from 0 to 1. Below 0.8 the hub holds the message back.
- `time`: optional, seconds since 1970.

Try it without a band:

```
curl -X POST http://127.0.0.1:8787/gesture -H 'Content-Type: application/json' -d '{"gesture":"water","confidence":0.9}'
```

If Zach is on another laptop, start the hub with `EPSILON_HOST=0.0.0.0` and give him this laptop's Wi-Fi address. Then set `EPSILON_TOKEN` too, and he sends it in an `X-Epsilon-Token` header.

## What the hub does with a gesture

```
gesture JSON -> decide -> sentence -> deliver -> log -> live page
```

1. **Decide** (`hub/decide.py`). Fixed rules first, in this order:
   - Confidence below the threshold (0.8): held back. Nothing is sent.
   - The same ordinary gesture again within 20 seconds: held back as a repeat.
   - An urgent gesture ("hurt"): urgent voice message.
   - Anything else: a text. Only here may the Gemini model change the choice (text, voice, or hold). It can never override the threshold and can never hold an urgent gesture. If Gemini is slow or has no key, the rules stand.
2. **Sentence.** Each gesture maps to a sentence the family wrote on the Settings page. No model writes sentences.
3. **Deliver.** A text goes out by iMessage (Photon Spectrum, in `imessage/`). An urgent one also gets an ElevenLabs voice recording that plays on the Messages page. Without keys, both steps are skipped and the message is only logged.
4. **Log and show.** Every gesture, sent or held, appears on the Messages page at once, with the reason.

## The pages

- `/` is the landing page for the pitch. It shows the latest real message.
- `/app` is the parent's Messages page: the list, the settings (child's name, who gets the messages, the sentence for each gesture), and test buttons for the demo.

It is meant to feel like a messages list, not like software to learn.

## Run it

```
python3 -m hub.app          # then open http://127.0.0.1:8787
python3 -m unittest hub.test_server hub.test_decide
```

Keys go in a local `.env` (see `.env.example`). Photon keys go in `imessage/.env`.

## What works now, and what does not

| Part | State |
|---|---|
| Hub, rules, log, live pages | Works. 23 tests pass. Checked in Chrome with test gestures. |
| Zach's gestures reaching the hub | Not joined yet. |
| ElevenLabs voice | Written, never run. Needs the key in `.env`. |
| Gemini decision | Written from memory, never run against Gemini. Needs a key. |
| iMessage | Sender written, never run. Blocked on the Photon setup below. |
| Phone layout | Written to work at phone widths. Not checked by eye. |

### Photon iMessage setup (only Vi can do these)

1. In the Photon dashboard, copy the project secret into `imessage/.env` as `PROJECT_SECRET`. The setup tool could not read it.
2. On the free shared line you can only text people you registered. Add the parent's phone number under Users, in the form +1XXXXXXXXXX.
3. A shared line cannot send the first message. From that phone, send an iMessage (not SMS) to the number Photon assigned.
4. Then start the hub with `EPSILON_IMESSAGE=1`.

The "too many unsuccessful attempts" message is not in Photon's docs. If it stays, email help@photon.codes with the project id.

## What research says we must respect

From sources by and for autistic people and AAC users (links are in the session notes):

- Say "non-speaking", not "nonverbal". Do not say "high" or "low functioning".
- This adds to the tablet or cards they already use. It never replaces them and is never a reason to take them away.
- A false message is a serious harm: words put in someone's mouth. Holding back doubtful matches is the core safety feature. Say so in the pitch.
- A message log is a privacy risk. AAC users in one study did not want always-on logging. Our log is for the demo. A real product should let the wearer see and delete it.
- Stimming is never flagged, counted, or commented on.
- Only quote numbers with their source. Example: in a 2012 survey of 1,218 families, 49% of autistic children had tried to wander off after age 4 (Pediatrics, self-selected sample).

## Schedule

| Time | What |
|---|---|
| 16:00 to 16:30 | Zach posts his first real gesture to the hub. Vi adds keys and does the Photon steps. |
| 16:30 to 17:00 | Voice and iMessage checked with real keys. Fix what breaks. |
| 17:00 to 17:20 | Record a backup video of the full path. |
| 17:20 to 17:50 | Rehearse the pitch. Polish only. |
| 18:00 | Submit. |

If iMessage is not working by 17:00, demo with the Messages page and the voice recording. Sound recognition, Deepgram, and Railway hosting come only after the backup video exists.

## Open questions

1. Zach: what are the exact gesture names you will send, and do you send a confidence number?
2. Zach: are you on the same laptop as the hub, or another one?
3. Is the threshold of 0.8 right? It depends on what Zach's confidence numbers look like for real and false gestures.
4. Should a weak "hurt" still go through? Today it is held like any weak match. A missed "hurt" may be worse than a false one.
5. Should Gemini be allowed to hold an ordinary request, or only to choose between text and voice?
6. "Call" today means a voice recording on the Messages page. A real phone call needs a phone service such as Twilio. Is the recording enough for the demo?
7. Which ElevenLabs voice: a stock one, or Vi's own? Whose voice should speak for the child is a real question for the family.
8. Who is the parent in the demo, and which phone number gets the text?
9. Which 5 gestures and sentences do the siblings need most?
10. Do we deploy to Railway for the demo, or run on the laptop? The laptop is safer for today.
