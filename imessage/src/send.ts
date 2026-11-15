// Send one iMessage and exit. Called by hub/server.py:  bun src/send.ts "+15551234567" "I would like some water, please."
// shortcut: the send calls below follow Photon's docs but were never run against a live line; check them once PROJECT_SECRET is set.
import { Spectrum, voice } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

// optional third argument: path of an audio file, sent as a voice message after the text (urgent messages)
const [to, text, audio] = process.argv.slice(2);
if (!to || !text) {
  console.error("usage: bun src/send.ts <phone or iMessage email> <text>");
  process.exit(2);
}

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});
const im = imessage(app);
const space = await im.space.create(await im.user(to));
await space.send(text);
if (audio) await space.send(voice(audio));
process.exit(0);
