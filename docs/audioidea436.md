# Audio idea 436: understand a wearer's own sounds

Status: idea only, written 2026-11-14. Nothing here is built.

## The need

Some autistic people do not speak in words but do make sounds: a certain "uh", a hum, a short word only their family understands. Each person's sounds are their own. A parent learns them over years. Software built for clear speech does not.

Goal: the band hears a sound the wearer makes on purpose, and the parent gets the meaning.

## Why normal speech-to-text is not enough

Deepgram and similar services turn clear speech into text. For a sound that is not a word, they return nothing or a wrong guess. So the main path cannot be "transcribe, then read the text".

## The primitive version that could work

Use the same idea as the gestures: teach, then match.

1. **Teach.** A parent picks a meaning ("water"). The wearer makes their sound for it three times. We save the three recordings.
2. **Listen.** When the wearer makes a sound, we compare it with the saved examples.
3. **Match or stay quiet.** If it is clearly close to one meaning, send that word to the app, the same way a gesture does. If not, do nothing.

The app after that point does not change. A sound and a gesture both arrive as one word.

## How the parts would fit

| Step | Tool | Note |
|---|---|---|
| Get the sound | The band's microphone, through the Vexo kit | The kit gives raw Opus packets and has a decoder to plain samples. We do the parsing |
| Compare with the examples | A sound fingerprint and a nearest-match check | No AI service needed for the first version |
| Clear words, when the wearer has some | Deepgram | Only as a second signal, never the only one |
| Decide what to do | The same decision model as gestures (Gemini) | It sees the match, how close it was, and recent messages |
| Remember examples and results | A small Postgres database (Neon) | To see which sounds are confused and whether matching improves |

## Things that block it on this band

- While the band's microphone is on, its light is locked blue. We lose the light as feedback.
- The microphone hears everyone nearby, not only the wearer. People around must be told, and sound sent to a company (Deepgram, Google) must be disclosed.
- Recordings of a child's voice are sensitive. Keep them on the family's own device where possible. Never put them in git.

## Risks to respect

- A wrong match puts words in someone's mouth. Stay quiet when unsure.
- Sounds made while stimming or upset are not requests. Never treat them as messages, and never log or flag them.
- Always-on listening is surveillance. Listening should start with a deliberate action by the wearer, such as a tap.

## Smallest test

Three meanings, three examples each, one wearer, a quiet room. Count correct matches out of 20 per meaning, and false matches in five minutes of ordinary sound. If that works, add noise, then add a second person.
