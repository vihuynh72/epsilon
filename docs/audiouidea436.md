# Sound idea: learn each person's own sounds

Status: idea and research only, 2026-11-14. Nothing here is built or tested. No autistic person has tried it.
This is a side idea. Gestures stay the main input. Read `docs/PLAN.md` first.

## One line

A person who cannot speak makes their own sound, for example a rising "EUEEEEHHH" for water. The laptop has learned that sound from a few examples, shows the card and speaks the word.

## What the research says

| Claim | What we found |
|---|---|
| Many minimally speaking people use sounds that mean the same thing each time | Yes. The sounds are "highly idiosyncratic to the speaker", so strangers cannot read them. Family members learn them. |
| Families read them well | Mostly, but not evenly. Some caregivers notice far more than others. Who labels the sounds matters. |
| A computer can tell them apart | Yes, but only modestly. MIT trained one model per person and got 0.75, 0.53 and 0.79 (average recall, 5 classes) for three people. That is wrong 1 time in 4 at best. |
| One model for everyone works | No. Starting from big shared audio models helped only 2 of 8 people. Models trained on each person's own sounds work better. |
| Training on the user's own voice is the normal method | Yes. Voiceitt (non-standard speech) trains on about 200 phrases per user (from news pages, not Voiceitt). |
| Sounds are rough versions of words | Partly. MIT counts "word approximations" in how it defines its group. That a sound keeps the word's vowel or syllable count is not shown. |

The main dataset is MIT's **ReCANVo**: 7,077 sounds from 8 people aged 6 to 23, recorded at home over 4 to 64 weeks. A family member labeled each sound on a phone at the moment it happened. Fixed labels: frustrated, delighted, dysregulated, self-talk, request, social. Each person also had up to 4 of their own, such as bathroom, hunger, more, yes, no.

For the pitch: adults answer spoken words more often than other sounds. Turning a sound into a spoken word may get the person answered more often.

## Can it beat the guardian?

- **With guardian labels, no, by definition.** The guardian is the answer key. Matching them perfectly is the ceiling.
- **On sound alone, maybe.** Play the guardian only the recording (no face, no room, no context) and their score drops. For clear, steady sounds a matcher may do as well. Nobody has tested this.
- **Where a machine can be better:** it never gets tired or distracted, it may pick up tiny sound changes (an early sign of distress, unproven), and it can spot patterns over weeks.
- **The real goal:** do as well as the guardian for people who are not the guardian: teachers, grandparents, shop workers, doctors.
- **Pitch line:** "It carries a parent's understanding to everyone else." Do not say "better than parents".

## Can it learn with no human at all?

- **Finding the person's sounds: yes.** A model can group weeks of sounds into "this person has about 6 sounds they repeat", without knowing what they mean.
- **Rough mood: weakly.** Crying, laughing and calm sound alike in most people, but MIT got only "weak groupings" trying this on this group.
- **Sounds close to a real word: sometimes.** A speech recogniser might hear "wa-wa" as water. Normal speech recognition is poor on non-standard speech.
- **Specific meanings: no.** Something has to link sound to meaning. It does not have to be a guardian labeling. It can be context (sound A happens at meals), outcomes (sound B, they get water, the sound stops), or the person's own confirm or cancel.
- **The least human input:** the model finds the sounds itself, then asks once per sound "What does this mean?". Confirms keep it right after that.

## The band's hardware (from the kit and our band)

| Part | Spec | What it means |
|---|---|---|
| Mic | 16 kHz mono, Opus about 24 kbit/s, 20 ms frames, fixed | Enough for pitch, vowel shape and loudness |
| Gain | 0 to +20 dB in 0.5 dB steps (default +20) | Set per person and per room |
| `MIC_LEVEL` | Loudness 10 times a second | Cheap "is there a sound" check; use it to set gain |
| Light | Solid blue while the mic is on; cannot be changed | Mic only on while listening, so blue means "listening" |
| Link | Sound and motion share one 4 KB send queue | Over Bluetooth, keep motion at 208 Hz; check for lost frames. USB is fine |
| Decoder | `vexo-open-kit/js/src/audio.js` decodes the sound in Chrome | No extra library |
| Missing | No speaker, vibration, GPS or screen. One program at a time | Output goes through the laptop or a phone page |

## Problems with a wrist mic, and the fix for each

1. **Far from the mouth (30 to 60 cm), and the distance changes.** Normalise each sound by its own average. Measure pitch against the person's usual pitch.
2. **Noise from the arm moving.** The band reads motion and sound at the same time. Throw away sound frames where the wrist moves fast. Too many thrown away: "didn't catch that".
3. **The tap that starts listening makes a thump.** Skip the first 150 ms.
4. **Room noise.** Measure it in the quiet moment at the start of each listen and subtract it.
5. **Lost frames over Bluetooth.** Count the gaps in `seq`. Over about 10% lost: "try again".

Most of the accuracy on cheap hardware comes from refusing bad clips. "Didn't catch that" is much better than a wrong "I'm hurt".

## How a sound becomes a word

```
start listening --> 3 s window --> stop
   |
   +-- skip 150 ms, measure room noise
   +-- find the sound: loudness above noise, 250 ms to 3 s
   +-- quality check (loud enough, wrist still, few lost frames) --fail--> "didn't catch that"
   +-- every 20 ms: 13 MFCC (vowel shape) + pitch + loudness, normalised per clip, squeezed to 32 points
   +-- DTW match against taught examples: a limit per word, a margin over the runner-up
   +--> sure: card + confirm      not sure: "try again" or "What was that?" + word tiles
```

- **DTW, not a big AI model.** It works from 3 to 8 examples, needs no training step and shows why it matched. A pretrained sound model (such as YAMNet) can be a second opinion later.
- **A "not a message" group.** Teach it humming, self-talk and room noise. Matches to it are ignored silently. Never flag or count them (stimming rule).
- **More examples for free.** Mix room noise into each taught example at a few loudness levels.
- **Learns as it is used.** A confirmed send becomes an example. Keep at most 8 per word and replace the oldest.
- **Warns about lookalikes.** Test each example against the others. If two sounds are too alike, ask for a more different sound.
- **Start with 3 or 4 sounds.**

## Quick demo plan (about 2 to 3 hours)

A separate **Sound** page using the laptop mic (or a cheap USB or clip-on mic). It does not need the band, so it never fights the band code for the connection.

1. **Teach before going on stage.** Click a word, make the sound 3 times. Do 3 words.
2. **Use.** Press Listen (big button or spacebar), make the sound. The card shows "Water?" with a short cancel bar.
3. **Send.** The page posts the same JSON as the band: `POST :8787/gesture` with `{"gesture": "water", "confidence": 0.9}`. The hub holds back anything below 0.8, so weak matches never speak. Card, voice and guardian app work unchanged.
4. **Files.** New only: `hub/sources/sound/` (page, mic code, a small copy of the DTW matcher) and a test with fake sounds (rising, falling and flat tones must match their own word, noise must be "not sure").
5. **Later.** Swap the laptop mic for the band mic. The code works at 16 kHz, the band's rate.

Demo day:

- Push-to-listen, never always on. It is the best guard against false sends in a loud hall.
- Use a USB or clip-on mic if you can get one.
- Teach clearly different sounds: a rising "eeeEH", a hummed "mm-mm", a choppy "ah-ah-ah". Different melody and rhythm match better than small vowel differences.
- Teach again in the real room just before presenting.
- Say it plainly: a teammate made up these sounds. The real version learns the person's own sounds.

## Test it on real sounds first (one afternoon, no band)

1. Record about 10 clips each of 3 or 4 sounds from one person, with the guardian saying what each meant. A phone is fine. Keep the clips in `data/`.
2. Test each clip against all the others (leave one out) and count how often it lands on the right meaning.
3. Play the same clips to the guardian in random order with no context, and score them too.

Above about 85% on 3 or 4 sounds: worth building. If two sounds keep getting mixed up and the guardian mixes them up too, the person probably uses one sound for two meanings.

## Should we build it today?

No. Get one gesture working end to end first: recognised, card shown, spoken. The sound demo is a bonus if there is time. Put it in the pitch as the next step: "Next, the band's mic learns each person's own sounds, the way families already do."

## Sources

- [ReCANVo dataset, Scientific Data 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10404278/)
- [Personalized modeling of real-world vocalizations from nonverbal individuals, MIT 2020](https://www.media.mit.edu/publications/personalized-modeling-of-real-world-vocalizations-from-nonverbal-individuals/)
- [Transfer learning with real-world nonverbal vocalizations, MIT](https://www.media.mit.edu/publications/transfer-learning-with-real-world-nonverbal-vocalizations-from-minimally-speaking-individuals/)
- [Commalla project, MIT Media Lab](https://www.media.mit.edu/projects/commalla/overview/)
- [The Transmitter on the dataset](https://www.thetransmitter.org/spectrum/researchers-publish-new-dataset-on-minimally-verbal-autistic-people/)
- [Bielefeld poster on idiosyncratic vocalizations](https://www.uni-bielefeld.de/fakultaeten/linguistik-literaturwissenschaft/forschung/fachbereich/phonetik/laughter-workshop/poster10.pdf)
- [La Valle et al. 2024 on how parents respond](https://pmc.ncbi.nlm.nih.gov/articles/PMC11247963)
- [Saul and Norbury 2020](https://discovery.ucl.ac.uk/id/eprint/10095078/1/Saul_Norbury_Autism_2020.pdf)
- [WRAL on Voiceitt](https://www.wral.com/archive/21638524/)
- Band specs: `vexo-open-kit/contract/contract.md` (sections 4, 5.3, 6) and `vexo-open-kit/docs/speech.md`
