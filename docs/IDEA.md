# Idea 2: wrist gestures that text a guardian (autism)

Status: draft, 2026-11-14. Not tested. Written from Vi's words after the Hearo (deaf and sign) plan.
The Hearo plan is kept as is, for another time. Nothing in `~/.paradev/projects/hearo`, `Projects/hearo`, or `docs/brainstorming/FINAL-BRIEF.md` was changed.

Vi's instruction: "do it on a different brainstorm and just leave the dev thing alone... just write a separate idea in your Claude folder."

## One line

A person who cannot speak makes a small gesture or tap pattern. The band recognises it. A text message with the meaning goes to their guardian.

## Who and why (Vi's words)

- Personal link: a teammate has autistic siblings. The siblings are not at the event.
- Today they use a tablet. They tap picture buttons to say what they want. Some use gestures, sounds, or cards.
- Goal: let them use gestures or taps on the band instead of, or next to, the tablet.
- Output: a text message to a parent or guardian. No speaker is needed. The band has none.

## How it works

1. **Set up (10 seconds).** The wearer stands with the arm straight down. The band saves this as the neutral pose. All gestures are measured from that pose. No height input is needed.
2. **Teach.** A guardian picks a meaning ("water", "bathroom", "I need a break", "I am hurt"). The wearer does their own gesture 3 times. The kit's gesture-trainer already works this way.
3. **Use.** The wearer does the gesture. The laptop hub matches it. A text goes to the guardian: "Water. Gesture 2, 9:41."
4. **Check.** The band LED flashes green: "sent". A double-tap means "wrong, cancel". The mic stays off, so the LED is free.

## Fit with the Vexo Open band (from the kit map)

- Motion sensor, tap and double-tap events: yes. Up to 100 Hz over Bluetooth.
- Wrist and arm motion only. No fingers.
- LED works because the mic is off.
- No haptic, speaker, or screen. The laptop sends the text.
- Phones cannot connect to the band. The laptop does the work.

## Open choices

- Text path: SMS service, Telegram, or push notification. A free test path is needed. Do not create accounts without asking Vi.
- Tap code vs. free gestures. Tap codes (1 tap, 2 taps, tap-hold) are more reliable but allow fewer meanings.
- Vocabulary size. Start with 4 to 6 meanings.

## Risks

- Accuracy is unknown. The kit's thresholds are guesses.
- Normal movement and stimming can trigger false matches. Stimming is not a problem to fix. Never flag it.
- A wrong text can alarm a parent. The cancel gesture and a "confirm?" step are required.
- No autistic person has tested this. Ask the teammate, then ask at the event.
- Consent: the wearer and the guardian both choose to use it. Do not claim the band reads minds.
- Messages are private. Do not store them on the band.

## Next questions

1. What does the sibling need to say most? List 5 to 10 things.
2. Do they accept a wrist band? Any sensory issue with wearing it?
3. Who gets the texts?
4. Which text path is easiest for the team to set up?

## Team and build rules (Vi, 2026-11-14)

- Split work by domain, not by a generic task list: one person on the website or app (the text and caregiver side), one on the band and gestures (hardware side), one on the demo and story.
- Build everything on a single laptop. The band connects to that laptop. It also sends the text.
- Pitch rule: the idea must matter to the user. Tell the sibling story.

## Name

Working name and repo: **Epsilon** (Vi's pick, changeable). Product name candidates: Cue, Wristword, Tapline, Handsay, Wrist Note.
