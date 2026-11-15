// The Sounds page: teach a wearer's own sounds, then listen and suggest what one may mean.
// Every server string is untrusted: textContent only. Nothing listens until a person presses a button.
import { BANDS, fingerprint, match, wordIn } from "/static/sound-match.js";

const $ = (id) => document.getElementById(id);
const K = new URLSearchParams(location.search).get("k");
const withKey = (url) => (K ? url + "?k=" + encodeURIComponent(K) : url);
if (K) document.querySelectorAll('a[href="/"], a[href="/app"], a[href="/sounds"], a[href="/setup"]').forEach((a) => { a.href = withKey(a.getAttribute("href")); });

const SECONDS = 2.5, FRAME_MS = 40, KEEP = 12; // keep the newest 12 examples per meaning
const STORE = "epsilon.sounds", HEARD = "epsilon.heard";
const load = (key, empty) => { try { return JSON.parse(localStorage.getItem(key)) || empty; } catch { return empty; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: memory only */ } };

let examples = load(STORE, []);   // [{meaning, print}]
let heardVotes = load(HEARD, {}); // what Deepgram wrote -> {meaning: times a person confirmed it}
let words = {};                   // meaning -> the sentence it sends
let urgentWords = [];             // the family's emergency words
let busy = false;
let latest = null;                // the try on screen

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const label = (m) => m.charAt(0).toUpperCase() + m.slice(1);

/** Record once: loudness frames for the matcher, and the audio itself only if Deepgram is switched on. */
async function record(wantAudio, onStart, seconds) {
  // made during the button press, before any waiting: a browser may refuse to start audio later
  const ctx = new AudioContext();
  ctx.resume();
  let stream;
  try {
  stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // the browser may ask the person here
  onStart();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const bins = new Float32Array(analyser.frequencyBinCount);
  const hz = ctx.sampleRate / analyser.fftSize;
  const edge = (i) => Math.round((100 * (60 ** (i / BANDS))) / hz); // 100 Hz to 6 kHz, log-spaced
  const frames = [], chunks = [];
  const recorder = wantAudio && window.MediaRecorder ? new MediaRecorder(stream) : null;
  if (recorder) { recorder.ondataavailable = (e) => chunks.push(e.data); recorder.start(); }
  const timer = setInterval(() => {
    analyser.getFloatFrequencyData(bins);
    const frame = [];
    for (let b = 0; b < BANDS; b += 1) {
      let sum = 0, n = 0;
      for (let i = edge(b); i < Math.max(edge(b) + 1, edge(b + 1)); i += 1) { sum += Math.max(-120, bins[i]); n += 1; }
      frame.push(sum / n);
    }
    frames.push(frame);
  }, FRAME_MS);
  await new Promise((done) => setTimeout(done, (seconds || SECONDS) * 1000));
  clearInterval(timer);
  const stopped = recorder ? new Promise((done) => { recorder.onstop = done; }) : null;
  if (recorder) recorder.stop();
  await stopped;
  return { frames, audio: recorder ? new Blob(chunks, { type: recorder.mimeType }) : null };
  } finally {
    if (stream) stream.getTracks().forEach((t) => t.stop()); // the microphone is off again, whatever happened
    ctx.close();
  }
}

/** The recording as a small WAV file (16 kHz, one channel): the form both listening services accept. */
async function toWav(blob) {
  const ctx = new AudioContext();
  try {
    const heard = await ctx.decodeAudioData(await blob.arrayBuffer());
    const off = new OfflineAudioContext(1, Math.ceil(heard.duration * 16000), 16000);
    const src = off.createBufferSource();
    src.buffer = heard;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, 36 + pcm.length * 2, true); text(8, "WAVEfmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, pcm.length * 2, true);
    pcm.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true));
    return new Blob([view], { type: "audio/wav" });
  } finally {
    ctx.close();
  }
}

async function capture(statusEl, wantAudio) {
  if (busy) return null;
  busy = true;
  statusEl.textContent = "Waiting for the microphone. If the browser asks, press Allow.";
  try {
    const got = await record(wantAudio, () => { statusEl.textContent = "Listening… make the sound now."; });
    const print = fingerprint(got.frames);
    statusEl.textContent = print ? "" : "No sound heard. Try again, a little closer.";
    return print ? { print, audio: got.audio } : null;
  } catch (err) {
    statusEl.textContent = "The microphone is not available. Allow it in the browser and try again.";
    return null;
  } finally {
    busy = false;
  }
}

function addExample(meaning, print) {
  examples.push({ meaning, print });
  const mine = examples.filter((e) => e.meaning === meaning);
  if (mine.length > KEEP) examples.splice(examples.indexOf(mine[0]), 1);
  save(STORE, examples);
  renderTeach();
}

function renderTeach() {
  const rows = $("teach-rows");
  rows.replaceChildren();
  Object.keys(words).forEach((m) => {
    const n = examples.filter((e) => e.meaning === m).length;
    const row = el("div", "sound-row");
    const text = el("div");
    text.append(el("p", "sound-name", label(m)), el("p", "quiet", n === 1 ? "1 example" : n + " examples"));
    const status = el("p", "form-msg");
    status.setAttribute("role", "status");
    const btn = el("button", "btn", "Record");
    btn.type = "button";
    btn.setAttribute("aria-label", "Record a sound for " + label(m));
    btn.onclick = async () => {
      btn.disabled = true;
      const got = await capture(status, false);
      if (got) addExample(m, got.print); else btn.disabled = false;
    };
    row.append(text, btn, status);
    rows.append(row);
  });
}

async function post(url, body, raw) {
  try {
    const r = await fetch(withKey(url), raw ? { method: "POST", headers: { "Content-Type": body.type || "audio/webm" }, body }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch (err) {
    return { ok: false, error: "Could not reach the hub." };
  }
}

function showStats(s) {
  const box = $("stats");
  box.replaceChildren();
  if (!s || !s.total) { box.append(el("p", "quiet", "No tries yet. Each answer you give is kept here, so you can see it get better.")); return; }
  let line = "Right first time: " + s.last10_right + " of the last " + s.last10 + " tries.";
  if (s.total > 10) line += " When you started it was " + s.first10_right + " of the first " + s.first10 + ".";
  box.append(el("p", null, line));
  Object.entries(s.by || {}).forEach(([m, v]) => box.append(el("p", "quiet", label(m) + ": right " + v.right + " of " + v.tries)));
  (s.mixups || []).forEach(([pair, n]) => box.append(el("p", "quiet", "Mixed up " + n + (n === 1 ? " time: " : " times: ") + pair + ". Try teaching both again, a little more clearly apart.")));
}

/** A person told us what the sound was. Learn from it and log it. Only a confirmed match is sent. */
async function settle(guess, meaning, attempt, send) {
  $("result-actions").replaceChildren();
  addExample(meaning, attempt.print);
  if (attempt.heard) {
    const votes = heardVotes[attempt.heard] || (heardVotes[attempt.heard] = {});
    votes[meaning] = (votes[meaning] || 0) + 1;
    save(HEARD, heardVotes);
  }
  showStats(await post("/api/sound-log", { guess, meaning, score: attempt.score, heard: attempt.heard, sure: attempt.sure }));
  if (!send) { $("result-detail").textContent = "Thank you. Epsilon will remember that this sound means " + label(meaning) + ". Nothing was sent."; return; }
  // an emergency carries the person's own recording, so the parent hears it as it was said
  let own = null;
  if (attempt.clip && urgentWords.includes(meaning)) own = (await post("/api/clip", attempt.clip, true)).audio || null;
  const sent = await post("/gesture", { gesture: meaning, confidence: attempt.score, via: "sound", audio: own });
  const e = sent.event || {};
  $("result-detail").textContent = !sent.ok ? (sent.error || "Could not send.")
    : e.action === "held" ? "Not sent. " + (e.reason || "It was held back.")
    : e.action === "call" ? "Sent as an urgent voice message." : "Sent to Messages.";
  if (sent.ok && e.action === "call" && $("use-deepgram").checked) followUp();
}

/** After an emergency: keep listening a little longer and pass on whatever else is said. */
async function followUp() {
  if (busy) return;
  busy = true;
  const note = $("result-detail");
  try {
    note.textContent = "Emergency sent. Listening for 6 more seconds, to pass on anything else that is said…";
    const got = await record(true, () => {}, 6);
    const clip = await toWav(got.audio).catch(() => got.audio);
    const said = ((await post("/api/transcribe", clip, true)).text || "").trim();
    if (!said) { note.textContent = "Emergency sent. Nothing more was heard."; return; }
    const more = await post("/gesture", { gesture: "spoken", text: "After the emergency: " + said, via: "voice" });
    note.textContent = more.ok ? "Emergency sent. Also sent what was heard next: “" + said + "”" : "Emergency sent.";
  } catch (err) {
    note.textContent = "Emergency sent.";
  } finally {
    busy = false;
  }
}

async function listen() {
  const btn = $("listen");
  btn.disabled = true;
  $("result").hidden = true;
  const got = await capture($("listen-status"), $("use-deepgram").checked);
  btn.disabled = false;
  if (!got) return;

  const m = match(got.print, examples);
  const attempt = { print: got.print, score: Math.round(m.score * 100) / 100, sure: m.sure, heard: "" };
  latest = attempt;
  $("result").hidden = false;
  $("result-heard").textContent = "";
  $("result-text").textContent = m.sure ? "This may mean: " + label(m.meaning) : "Not sure what that was.";
  $("result-detail").textContent = m.meaning
    ? "Sounds most like " + label(m.meaning) + " (match " + Math.round(attempt.score * 100) + "%, next closest " + Math.round(m.runnerUp * 100) + "%)."
    : "No sounds are taught yet. Teach a few first.";

  const actions = $("result-actions");
  actions.replaceChildren();
  const choice = (text, meaning, send) => {
    const b = el("button", "btn" + (send ? " btn-primary" : ""), text);
    b.type = "button";
    b.onclick = () => settle(m.sure ? m.meaning : null, meaning, attempt, send);
    actions.append(b);
  };
  if (m.sure) choice("Yes, send " + label(m.meaning), m.meaning, true);
  Object.keys(words).filter((w) => !(m.sure && w === m.meaning)).forEach((w) => choice("Teach: it was " + label(w), w, false));
  const none = el("button", "btn", "It was nothing");
  none.type = "button";
  none.onclick = () => { $("result").hidden = true; };
  actions.append(none);

  if (got.audio) {
    $("result-heard").textContent = "Gemini and Deepgram are listening…";
    const clip = await toWav(got.audio).catch(() => got.audio); // if the browser cannot convert it, send it as it is
    attempt.clip = clip;
    const [d, g] = await Promise.all([post("/api/transcribe", clip, true), post("/api/guess", clip, true)]);
    if (latest !== attempt) return; // a newer try is on screen
    // Gemini heard the recording itself: for speech that is unclear or said in the person's own way
    if (g.ok && g.word && g.word !== "unsure" && g.word in words && !(m.sure && m.meaning === g.word)) {
      $("result-text").textContent = "Gemini thinks this may be: " + label(g.word);
      $("result-detail").textContent = "It sounded like “" + (g.heard || "?") + "” (" + Math.round((g.confidence || 0) * 100) + "% sure). Say yes and Epsilon learns this sound for next time.";
      const yes = el("button", "btn btn-primary", "Yes, send " + label(g.word));
      yes.type = "button";
      yes.onclick = () => settle(g.word, g.word, Object.assign(attempt, { sure: true, score: Math.round((g.confidence || 0) * 100) / 100 }), true);
      $("result-actions").prepend(yes);
    }
    attempt.heard = (d.text || "").trim().toLowerCase();
    // a clearly spoken word that is one of the family's words: offer to send it, even if no sound was taught
    const said = d.ok ? wordIn(attempt.heard, Object.keys(words)) : null;
    if (said && !(m.sure && m.meaning === said)) {
      $("result-text").textContent = "Heard the word: " + label(said);
      const b = el("button", "btn btn-primary", "Yes, send " + label(said));
      b.type = "button";
      b.onclick = () => settle(said, said, Object.assign(attempt, { sure: true, score: 1 }), true);
      $("result-actions").prepend(b);
    }
    // any sentence Deepgram could write down: a person can read it and choose to send it as it is
    if (d.ok && attempt.heard && !said) {
      const sentence = (d.text || "").trim();
      const b = el("button", "btn btn-primary", "Send what was said");
      b.type = "button";
      b.onclick = async () => {
        $("result-actions").replaceChildren();
        const sent = await post("/gesture", { gesture: "spoken", text: sentence, via: "voice" });
        $("result-detail").textContent = sent.ok ? "Sent to Messages: “" + sentence + "”" : (sent.error || "Could not send.");
      };
      $("result-text").textContent = "“" + sentence + "”";
      $("result-actions").prepend(b);
    }
    const votes = heardVotes[attempt.heard];
    const learned = votes ? Object.entries(votes).sort((a, b) => b[1] - a[1])[0] : null;
    $("result-heard").textContent = !d.ok ? (d.error || "Deepgram did not answer.")
      : !attempt.heard ? "Deepgram heard no words."
      : "Deepgram wrote “" + attempt.heard + "”." + (learned ? " You have said that means " + label(learned[0]) + " " + learned[1] + (learned[1] === 1 ? " time." : " times.") : " That is only its guess at words.");
  }
}

$("listen").onclick = listen;
$("forget").onclick = () => {
  examples = []; heardVotes = {};
  save(STORE, examples); save(HEARD, heardVotes);
  renderTeach();
  $("result").hidden = true;
};

fetch(withKey("/api/state"), { cache: "no-store" }).then((r) => r.json()).then((s) => {
  words = (s.config && s.config.phrases) || {};
  urgentWords = s.urgent || [];
  renderTeach();
}).catch(() => { $("teach-error").textContent = "Could not load the list of meanings from the hub."; });
fetch(withKey("/api/sound-log")).then((r) => r.json()).then(showStats).catch(() => {});
// remember the choice to use the online listeners, so a family sets it once
try { $("use-deepgram").checked = localStorage.getItem("epsilon.listeners") === "on"; } catch { /* private window */ }
$("use-deepgram").onchange = () => { try { localStorage.setItem("epsilon.listeners", $("use-deepgram").checked ? "on" : "off"); } catch { /* private window */ } };
