# Epsilon: wrist gestures that speak for a person who cannot (autism)

Status: draft v2, 2026-11-14. Not tested. Written from Vi's words.
Separate from Hearo (deaf and sign). The Hearo plan is unchanged and lives in `docs/brainstorming/FINAL-BRIEF.md` and `~/.paradev/projects/hearo`. Nothing here edits it.

## One line

A person who cannot speak makes a small gesture or tap pattern. The band recognises it. The laptop shows the meaning on a big card and says it aloud.

## Who and why (Vi's words)

- Personal link: a teammate has autistic siblings. The siblings are not at the event.
- Today they use a tablet. They tap picture buttons. Some use gestures, sounds, or cards.
- Goal: let them use gestures or taps on the band, next to or instead of the tablet.
- Pitch rule: it must matter to the user. Tell the sibling story.

## How it works

1. **Neutral pose (10 s).** The wearer stands with the arm straight down. The accelerometer saves gravity direction as zero. Gestures are measured from there. No height input.
2. **Teach.** A guardian picks a meaning ("water", "bathroom", "I need a break", "I am hurt"). The wearer does their own gesture 3 times. The kit's gesture-trainer works this way.
3. **Use.** The wearer does the gesture. The laptop matches it with its own motion matcher.
4. **Output.** The laptop shows a large card ("Water", time, history) and plays a chime, then speaks the meaning. A phone can open the same page over Wi-Fi, because the laptop serves it. The band cannot send text.
5. **Check.** The band LED flashes green for "sent". A double-tap cancels a wrong match. The band mic stays off, so the LED is free.

## Smart technology (sponsors)

| Tech | Job | Priority |
|---|---|---|
| ElevenLabs | Speaks the meaning. The guardian picks the voice. | Core |
| OpenAI (organiser key) | Reads gesture, time of day, and recent history. Chooses one phrase from a list we wrote ("Water" becomes "Can I have some water, please?"). Uses the kit's `ai.choose`. Never invents actions. | Core |
| Deepgram (organiser key) | Hears the guardian's spoken reply ("Coming!"). The LED shows "they heard you". Use the laptop mic, because the band mic locks the LED to blue. | Stretch |
| Mastra | Gesture log and patterns for the guardian ("Water asked 4 times after lunch"). | Optional |

Not used: Stripe, Brex, Minimax. They do not fit.

Gesture matching runs on our own matcher, not on an LLM. An LLM cannot see the wearer's hand. It only helps choose and phrase the meaning.

## Fit with the Vexo Open band (kit map)

- Motion sensor, tap and double-tap events: yes. Up to 100 Hz over Bluetooth.
- Wrist and arm motion only. No fingers.
- No haptic, speaker, or screen. The laptop does output.
- A phone cannot connect to the band. The laptop does.
- One connection at a time. Everything resets when the link closes.

## Team and build rules (Vi, 2026-11-14)

- Split work by domain, not by a generic task list: the site or app (the card, history, voice), the band and gestures (matcher, neutral pose), the demo and story.
- Build everything on one laptop.
- Name: Epsilon is the working name and repo. Product name candidates: Cue, Wristword, Tapline, Handsay, Wrist Note.

## Risks

- Accuracy is unknown. The kit's thresholds are guesses.
- Normal movement and stimming can trigger false matches. Stimming is not a problem to fix. Never flag it.
- A wrong spoken phrase can confuse or alarm. Keep the cancel gesture and a short "confirm?" step.
- No autistic person has tested this. Ask the teammate, then ask at the event.
- Consent: the wearer and guardian both choose to use it. Do not claim the band reads minds.
- Do not store messages on the band. Its storage is not private.

## Next questions for the teammate

1. What do the siblings most need to say? List 5 to 10 things.
2. Would they wear a wrist band? Any sensory issue?
3. Who is the guardian in the demo, and which device shows the card?

## Build order

1. Connect the band and read motion (kit example).
2. Neutral pose and a matcher for 4 to 6 gestures. Test it on teammates.
3. Card page plus ElevenLabs voice.
4. OpenAI phrase choice.
5. Stretch: Deepgram reply, then Mastra log.
