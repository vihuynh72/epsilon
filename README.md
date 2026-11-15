# Epsilon

**One wrist gesture becomes one message home.**

Epsilon is a wristband for a child who does not speak. They move their wrist, or make their own sound, and their parent gets a text. For an emergency word, the parent also gets a voice message.

Built in one day at VexoHacks (14 November 2026) by Vi, Arun, and Zach.

> A prototype. Not yet tested with autistic users. It does not read minds: only the wearer's own gesture or sound sends a message.

## You have a band. Now what?

A parent needs one thing: a phone that gets iMessages. There is no app to install, and everything is one web address.

- [ ] **1. Open Epsilon and go to Set up.** Type your phone number. Press Save.
- [ ] **2. Say hello once.** Send one iMessage to the Epsilon number, so it is allowed to text you.
- [ ] **3. Pick the words.** Water, food, parents, sleep, and help are ready. Change a sentence, add your own word, or tick **Emergency**. Press **Try it** and check your phone.
- [ ] **4. Open the band page** from Set up, in Chrome on a laptop. Press Connect. It uses Bluetooth or a cable.
- [ ] **5. Teach each gesture.** Pick a word and let your child show their own movement a few times. A word you added in step 3 is there to teach too.
- [ ] **6. Switch on "Send to the guardian app".**

Done. When your child makes a gesture, you get the text. **Messages** shows the conversation.

## What happens to each word

| Gemini decides | You get |
|---|---|
| A clear, new word | A text: "I want water, please." |
| An emergency word | The text and a voice message |
| A doubtful match, or the same word again seconds later | Nothing. It is held back, and Messages says why |

Two rules are fixed in code: an emergency word is never held back, and neither is a clear, new word.

## What it is built with

| Technology | What it does here |
|---|---|
| Vexo Open band | The wristband. Its motion sensor reads the gesture |
| Gemini (fast model) | Decides each message in under a second, and gives its reason |
| Gemini 4 Hydrogen | Reads the day's messages and writes a short summary with one suggestion |
| Gemini, listening | Hears unclear speech and suggests which word it most likely is. A person confirms |
| Deepgram | Writes down spoken words on the Sounds page |
| ElevenLabs | Speaks the emergency message |
| Photon Spectrum | Delivers the texts and voice messages by iMessage |
| Railway | Hosts the app |

## The pages

| Page | For |
|---|---|
| Messages | The conversation, as chat bubbles. Tap the line under a bubble for the reason. "What does today look like?" gives the summary |
| Sounds | Teach a person's own sounds, or say a word your own way. It says what it *may* mean, and you confirm |
| Set up | Phone number, words, emergencies, the band page, and a live check of each connection |

<details>
<summary><b>Run it yourself</b></summary>

Needs Python 3.9 or newer. Nothing to install.

```
python3 -m hub.app
```

Open http://127.0.0.1:8787, go to **Set up**, and press **Try it** on a word. Then open **Messages**. The band page is at `/band`.

Keys go in a local `.env` (names are in `.env.example`). All are optional: without them the app still runs and shows every message. Real texts also need Bun, `imessage/.env`, and `EPSILON_IMESSAGE=1`.

Tests: `python3 -m unittest hub.test_server hub.test_decide hub.test_insight` and `node --test hub/test/gestures.test.mjs hub/test_sound.test.mjs`
</details>

## What is real today

| Part | State |
|---|---|
| Gestures taught and recognised | Works. Accuracy on a real wrist is not measured |
| Gemini deciding, and the day summary | Works |
| iMessage text and emergency voice message | Works. Sent to a real phone at the event |
| Gemini understanding unclear speech | Works on test recordings. Not tried with a real wearer |
| A ringing phone call | Not working |
| Tested with autistic users | No |

## What we hold to

- A false message puts words in someone's mouth. When unsure, Epsilon stays quiet.
- Stimming is never flagged, counted, or commented on.
- It adds to the tablet or cards a person already uses. It never replaces them.

More: [how the parts join](docs/PLAN.md) · [submission text](docs/DEVPOST.md) · [the sound idea and its research](docs/audioidea436.md)
