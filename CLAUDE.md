# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Epsilon is a VexoHacks (2026-11-14) project: a Vexo Open wristband lets an autistic person who cannot speak send one of 5 taught wrist positions. The laptop shows the meaning as a card and speaks it, and the guardian replies with one tap. Design for the wearer, not for a general audience.

Status: the hub and pages work with test gestures. Read `docs/PLAN.md` first: it holds the current split (Zach owns the band and gestures and POSTs JSON; this repo owns everything after), the JSON contract, and what is still unverified. Where this file and `docs/PLAN.md` disagree about architecture, PLAN.md is newer and wins.

Current code: `python3 -m hub.app` (run from the repo root; stdlib only) serves `/`, `/app` and `POST /gesture` on port 8787. `hub/decide.py` holds the hold/text/call rules, `hub/voice.py` the ElevenLabs call, `hub/web/` the pages (tokens in `tokens.css`; use only those), and `imessage/` a Bun sender for Photon Spectrum. Tests: `python3 -m unittest hub.test_server hub.test_decide`, or one test with `python3 -m unittest hub.test_decide.<Class>.<test>`.

## How to work here: orchestrate, do not build alone

The main session is the orchestrator and adviser. It plans, splits, briefs, reviews, and reports. Subagents do the building, in parallel.

- Split work by the three domains in `docs/PLAN.md` (band and gestures; hub and voice; page, demo, and story). Never split by filename.
- Opus agents take the unclear or hard parts: the position matcher and its tuning, anything that crosses domains, and review of finished work.
- Sonnet agents take well-specified work with a clear check: the page, hub plumbing, tests, docs.
- Launch independent agents in one message so they run at once. An agent knows only its brief, so give it the goal, its domain section of the plan, the four messages, the files it owns, its acceptance check, and the rules below. Agents sharing the worktree own disjoint files.
- Each domain must run alone against a fake of the others (pretend band, a fake `gesture` script, a fake card button). Join only after each works alone.
- The orchestrator runs each agent's check itself before reporting the work as done.

## Architecture

```
band --USB or Bluetooth--> hub (Python): band -> matcher -> phrase -> voice
                                              \-> page server <-> card page (browser)
```

- One Python hub on one laptop. Modules follow `hub/sources/` (band), `hub/skills/` (matcher, phrase choice), `hub/sinks/` (voice, light, page), joined by one event bus carrying `gesture`, `cancel`, `card`, `reply`.
- Start from the Hearo hub at `~/.paradev/projects/hearo/hub/` (separate repo, read-only for us): `bus.py`, `sources/band.py` (connect, auto-reconnect, sim mode, light, a scripted self-check), `sinks/voice.py` (ElevenLabs with the macOS `say` fallback), `sinks/screen.py` and `web/`. Copy what fits and drop the camera, sign, and caption parts. Never edit the Hearo repo.
- A "gesture" is a wrist position held still for about a second, matched against 3 taught examples by gravity direction, with a "not sure" limit. Not a moving shape.
- An AI model only chooses wording from phrases we wrote (the kit's `ai.choose` in `vexo-open-kit/examples/python/ai.py`). It never decides which position was made and never invents an action. If it is slow, speak the plain label.

## The band

`vexo-open-kit/` is vendored, MIT, unmodified. Never edit it. `vexo-open-kit/AGENTS.md` is the full guide and its rules apply to our code; `vexo-open-kit/docs/api.md` lists every call.

- **Band number.** Ask the team before writing or running anything that connects. Never guess it, never use 42 or 7 from the examples, never take it from an old conversation. Keep it in one place (`VEXO_BAND` in `.env`).
- The event band is weaker than the consumer bracelet: motion sensor, light, mic only. No vibration, speaker, or screen.
- Measured on our band earlier: the USB cable (`transport="serial"`, needs `pyserial`) connects and streams motion. Tap events were not seen in a short test, so do not depend on taps until proven. Battery percent is wrong while charging.
- Everything is off until `configure(...)`, and every setting resets when the link closes. The accelerometer cuts off at 2 g by default: widen the range after each connect.
- One Bluetooth connection at a time. Close the kit dashboard before running the hub.
- No light commands while the microphone is on. Keep the band mic off; spoken replies use the laptop mic.
- Band storage is readable by anyone. Store nothing on it.
- Every threshold in the kit and in the Hearo code is a guess. Tune on a real wrist and report measured numbers.

## Commands

Python 3.9 or newer, Node 18 or newer. The pretend band needs nothing installed. A real band needs `python3 -m pip install pyserial` (cable) or `bleak` (Bluetooth).

Kit dashboard, to check the band without our code (always with the bind flag, or `.env` is readable by the whole Wi-Fi):

    python3 -m http.server 8000 --bind 127.0.0.1
    # then http://localhost:8000/vexo-open-kit/dashboard/?band=<our number>

Check that the keys work (no band needed):

    python3 vexo-open-kit/examples/python/check_keys.py

See motion from the pretend band:

    python3 vexo-open-kit/examples/python/motion.py --sim --seconds 3

Kit tests, from `vexo-open-kit/` (they confirm the kit is intact; they do not test our code):

    (cd python && python3 -m unittest discover -s tests)
    node --test js/test/*.test.js
    node --test projects/test/<name>.test.mjs        # one file

Our hub has no code or tests yet. Follow the Hearo pattern: each module has a self-check run as `python3 -m hub.<package>.<module>` against the pretend band.

## Rules for this project

- Keys live in `.env` only. Never ask for a key in chat, never write one into a file, never print one. A key that appears in the conversation is leaked: say so and tell the user to tell an organiser.
- Recordings and captured data go in `data/`, which git ignores.
- Stimming is never flagged, counted, or commented on, in code or in copy.
- Never claim the band reads minds, that accuracy is known, or that autistic users tested it. Say what was measured.
- The wearer can always cancel and can always stay silent. Nothing sends a message for them.
- Same position, same meaning, every time.
- Team-facing docs use short plain sentences.
