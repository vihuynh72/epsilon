# Epsilon

Working name. A wrist band that lets a person who cannot speak send a message with a gesture or tap. The meaning goes to a guardian as a text message.

Built for VexoHacks (Nov 14, 2026) on the Vexo Open event band.

## Idea

Read [docs/IDEA.md](docs/IDEA.md). Short version:

1. Set a neutral pose (arm straight down).
2. A guardian teaches each gesture: show it 3 times, name its meaning.
3. The wearer makes the gesture. The laptop matches it and texts the guardian.
4. The LED flashes green for "sent". A double-tap cancels.

Status: idea only. Nothing is tested. No autistic person has tried it yet.

## Layout

| Path | What it is |
|---|---|
| `docs/IDEA.md` | The plan, risks, open questions |
| `vexo-open-kit/` | Vexo Open kit (MIT), unmodified. Use it to connect and test the band |
| `hub/` | Our code goes here (`sources/`, `skills/`, `sinks/`) |
| `data/` | Local recordings and test data. Ignored by git |
| `.env.example` | Names of the keys we need. Copy to `.env`. Never commit `.env` |

## Connect the band

Follow `vexo-open-kit/README.md`. Use a laptop with Chrome or Edge. Double-tap the band to open a 60 second connect window. Only connect to your own band number.

## Rules for this repo

- No keys, tokens, or recordings in git. `.gitignore` blocks `.env`, key files, and audio or video.
- Messages from real people stay off the band. Band storage is not private.
- Stimming is not a problem to fix. The product must never flag it.
- Do not claim the band reads minds. The wearer's gesture comes first.
