# Epsilon

**One wrist gesture becomes one message home.**

Epsilon is a wristband for a child who does not speak. They move their wrist, and their parent gets a text. For an emergency word, the parent also gets a voice message.

Built in one day at VexoHacks (14 November 2026) by Vi, Arun, and Zach, on the Vexo Open event band.

> A prototype. Not yet tested with autistic users. It does not read minds: only the wearer's own gesture sends a message.

## You have a band. Now what?

A parent needs one thing: a phone that gets iMessages. There is no app to install.

- [ ] **1. Open Epsilon and go to Set up.** Type your phone number. Press Save.
- [ ] **2. Say hello once.** Send one iMessage to the Epsilon number. After that it is allowed to text you. (A limit of this prototype's shared line.)
- [ ] **3. Pick the words.** Water, food, parents, sleep, and help are ready. Change a sentence, add a word, or tick **Emergency**. Press **Try it** and check your phone.
- [ ] **4. Connect the band.** On a laptop near your child, open the band page in Chrome, press Connect, and choose the band. It uses Bluetooth. Nothing to pair on your phone.
- [ ] **5. Teach each gesture.** Pick a word and let your child show their own movement a few times.

Done. When your child makes a gesture, you get the text. **Messages** shows the whole conversation.

## What happens to each gesture

```
gesture -> band page matches it -> Gemini decides -> text / voice message / held back -> Messages
```

| Gemini decides | You get |
|---|---|
| A clear, new word | A text: "I want water, please." |
| An emergency word | The text and a voice message |
| A doubtful match, or the same word again seconds later | Nothing. It is held back, and Messages says why |

Two rules are fixed in code and Gemini cannot break them: an emergency word is never held back, and a clear, new word is never held back.

<details>
<summary><b>Try it in two minutes, with no band</b></summary>

Needs Python 3.9 or newer. Nothing to install.

```
python3 -m hub.app
```

Open http://127.0.0.1:8787, go to **Set up**, and press **Try it** on a word. Then open **Messages**.

Or send a word the way the band does:

```
curl -X POST http://127.0.0.1:8787/gesture -H 'Content-Type: application/json' -d '{"gesture":"water","confidence":0.9}'
```
</details>

<details>
<summary><b>Run the whole thing</b></summary>

```
python3 -m hub.app                                               # the app, port 8787
python3 hub/server.py --forward http://127.0.0.1:8787/gesture    # the band page, port 8000 (Chrome)
```

Keys go in a local `.env` (names are in `.env.example`). All are optional: without them the app still runs and shows every message.

| Key | Turns on |
|---|---|
| `GEMINI_API_KEY` | The decision model. Without it, fixed rules decide |
| `ELEVENLABS_API_KEY` | The emergency voice message |
| `DEEPGRAM_API_KEY` | "What Deepgram hears" on the Sounds page |
| `imessage/.env` and `EPSILON_IMESSAGE=1` | Real texts, through Photon Spectrum (needs Bun) |

**Set up → Connections** shows which of these are working, with a button that asks Gemini a real question.

Tests: `python3 -m unittest hub.test_server hub.test_decide` and `node --test hub/test/gestures.test.mjs hub/test_sound.test.mjs`
</details>

<details>
<summary><b>The pages</b></summary>

| Page | For |
|---|---|
| Messages | The conversation, as chat bubbles. Tap the line under a bubble for the reason |
| Set up | Phone number, words, emergencies, connections |
| Sounds | Teach a person's own sounds. It says what a sound *may* mean, and you confirm |
</details>

## What is real today

| Part | State |
|---|---|
| Gestures taught and recognised on the band page | Works. Accuracy on a real wrist is not measured |
| Gemini deciding, in about a second | Works |
| iMessage text and emergency voice message | Works. Sent to a real phone during the event |
| Sounds page | Built. Not yet tried with a real wearer |
| A ringing phone call | Not working. Written, but no phone service is connected |
| Tested with autistic users | No |

## What we hold to

- A false message puts words in someone's mouth. When unsure, Epsilon stays quiet.
- Stimming is never flagged, counted, or commented on.
- It adds to the tablet or cards a person already uses. It never replaces them.
- No keys or recordings in git. Nothing is stored on the band.

More: [how the parts join](docs/PLAN.md) · [submission text](docs/DEVPOST.md) · [the sound idea and its research](docs/audioidea436.md)
