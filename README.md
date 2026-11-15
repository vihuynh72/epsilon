# Epsilon

**One wrist gesture becomes one message home.**

Epsilon is a wristband for a child who does not speak. They move their wrist, and their parent gets a text. For an emergency word, the parent also gets a voice message.

Built in one day at VexoHacks (14 November 2026) by Vi, Arun, and Zach.

> A prototype. Not yet tested with autistic users. It does not read minds: only the wearer's own gesture sends a message.

## You have a band. Now what?

A parent needs one thing: a phone that gets iMessages. There is no app to install.

- [ ] **1. Open Epsilon and go to Set up.** Type your phone number. Press Save.
- [ ] **2. Say hello once.** Send one iMessage to the Epsilon number, so it is allowed to text you.
- [ ] **3. Pick the words.** Water, food, parents, sleep, and help are ready. Change a sentence, add a word, or tick **Emergency**. Press **Try it** and check your phone.
- [ ] **4. Connect the band.** On a laptop near your child, open the band page in Chrome and press Connect. It uses Bluetooth.
- [ ] **5. Teach each gesture.** Pick a word and let your child show their own movement a few times.

Done. When your child makes a gesture, you get the text. **Messages** shows the whole conversation.

## What happens to each gesture

| Gemini decides | You get |
|---|---|
| A clear, new word | A text: "I want water, please." |
| An emergency word | The text and a voice message |
| A doubtful match, or the same word again seconds later | Nothing. It is held back, and Messages says why |

Two rules are fixed in code: an emergency word is never held back, and neither is a clear, new word.

<details>
<summary><b>Try it in two minutes, with no band</b></summary>

Needs Python 3.9 or newer. Nothing to install.

```
python3 -m hub.app
```

Open http://127.0.0.1:8787, go to **Set up**, and press **Try it** on a word. Then open **Messages**.

</details>

<details>
<summary><b>Run the whole thing</b></summary>

```
python3 -m hub.app                                               # the app, port 8787
python3 hub/server.py --forward http://127.0.0.1:8787/gesture    # the band page, port 8000 (Chrome)
```

Keys go in a local `.env` (names are in `.env.example`). All are optional: without them the app still runs and shows every message. **Set up → Connections** shows which services are working.

Tests: `python3 -m unittest hub.test_server hub.test_decide` and `node --test hub/test/gestures.test.mjs hub/test_sound.test.mjs`
</details>

## What is real today

| Part | State |
|---|---|
| Gestures taught and recognised | Works. Accuracy on a real wrist is not measured |
| Gemini deciding, in about a second | Works |
| iMessage text and emergency voice message | Works. Sent to a real phone at the event |
| Sounds page (teach a person's own sounds) | Built. Not tried with a real wearer |
| A ringing phone call | Not working |
| Tested with autistic users | No |

## What we hold to

- A false message puts words in someone's mouth. When unsure, Epsilon stays quiet.
- Stimming is never flagged, counted, or commented on.
- It adds to the tablet or cards a person already uses. It never replaces them.

More: [how the parts join](docs/PLAN.md) · [submission text](docs/DEVPOST.md) · [the sound idea and its research](docs/audioidea436.md)
