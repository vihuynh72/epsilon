# Devpost submission text

Copy the sections below into Devpost. Check every claim against what you demo.

## Name

Epsilon

## Tagline

One wrist gesture becomes one message home.

## What it does

Epsilon lets a non-speaking autistic child ask for what they need with a small wrist movement. The child wears a Vexo Open band and makes a gesture they were taught: water, food, parents, sleep, or help. Their parent gets a plain text message, such as "I want water, please." For an urgent word like help, the parent also gets a voice message.

Every message appears live on a simple Messages page, with the reason it was sent or held back.

## Why we built it

One of our teammates has autistic siblings. Today they communicate with a tablet of picture buttons. The tablet has to be in their hands, and it is slow. A wristband is always there and needs no screen. Epsilon is meant to sit beside the tools they already use, not to replace them.

## How it works

1. The wearer teaches the band their own gestures by showing each one a few times. Every person moves differently, so there is no fixed set.
2. A page in Chrome reads the band's motion sensor over Bluetooth and matches each movement against the taught examples.
3. A recognised word goes to our server. A Gemini decision model looks at the word, how sure the match was, the time, and recent messages. It chooses one of three actions: send a text, send an urgent voice message, or hold the message back. It gives its reason in one sentence. One rule is fixed in code: an urgent word is never held back. If the model is unavailable, simple rules decide.
4. Texts go out as iMessages through Photon Spectrum. Voice messages are made with ElevenLabs.
5. The parent's Messages page shows the conversation as chat bubbles in real time. A Set up page holds the words, the emergency words, and a live check that each service is connected.

## The part we care about most

A false message is a real harm. It puts words in the mouth of someone who cannot easily correct it. So Epsilon is built to stay quiet when it is not sure. Doubtful matches and accidental repeats are held back, and the page says why. We never flag or count stimming.

## How we built it

- Vexo Open band: motion sensor and taps, read in the browser with the Vexo Open kit
- Python standard library server, with no framework
- Gemini as the decision model, with fixed rules as the fallback
- Photon Spectrum for iMessage
- ElevenLabs for the voice message
- Deployed on Railway

## Challenges

- The event band has a motion sensor, a light, and a microphone, and nothing else. There is no vibration and no screen, so all feedback has to happen elsewhere.
- Telling a deliberate gesture from ordinary movement.
- A shared iMessage line cannot send the first message. The parent has to text it once.
- Our first decision prompt held back every word from the band, because the band sends no confidence score. We caught it by testing real cases and fixed the wording.

## What is real and what is not

- Real: gestures taught and recognised on the band page, words reaching the server, Gemini deciding in about a second, real iMessages and voice messages delivered to a phone, the live Messages page. A Sounds page where a family teaches a person's own sounds is built but has not been tried with a real wearer.
- Not done: we have not measured gesture accuracy on a real wrist, and no autistic person has tested it.

## What is next

- Test with the family, starting with which five things matter most to say.
- Let the wearer see and delete their own message log.
- Understand a wearer's own sounds, not only gestures (see `docs/audioidea436.md`).
- A reply from the parent that the wearer can see on the band's light.

## Sponsor tracks

Vexo, Gemini, Photon, ElevenLabs.
