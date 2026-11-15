// The Sounds page: teach a wearer's own sounds, then listen and suggest what one may mean.
// Every server string is untrusted: textContent only. Nothing listens until a person presses a button.
import { BANDS, fingerprint, match } from "/static/sound-match.js";

const $ = (id) => document.getElementById(id);
const K = new URLSearchParams(location.search).get("k");
const withKey = (url) => (K ? url + "?k=" + encodeURIComponent(K) : url);
if (K) document.querySelectorAll('a[href="/"], a[href="/app"], a[href="/sounds"]').forEach((a) => { a.href = withKey(a.getAttribute("href")); });

const SECONDS = 2.5, FRAME_MS = 40, KEEP = 12; // keep the newest 12 examples per meaning
const STORE = "epsilon.sounds", HEARD = "epsilon.heard";
const load = (key, empty) => { try { return JSON.parse(localStorage.getItem(key)) || empty; } catch { return empty; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: memory only */ } };

let examples = load(STORE, []);   // [{meaning, print}]
let heardVotes = load(HEARD, {}); // what Deepgram wrote -> {meaning: times a person confirmed it}
let words = {};                   // meaning -> the sentence it sends
let busy = false;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const label = (m) => m.charAt(0).toUpperCase() + m.slice(1);

/** Record once: loudness frames for the matcher, and the audio itself only if Deepgram is switched on. */
async function record(wantAudio) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext();
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
  await new Promise((done) => setTimeout(done, SECONDS * 1000));
  clearInterval(timer);
  const stopped = recorder ? new Promise((done) => { recorder.onstop = done; }) : null;
  if (recorder) recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop()); // the microphone is off again
  await ctx.close();
  return { frames, audio: recorder ? new Blob(chunks, { type: recorder.mimeType }) : null };
}

async function capture(statusEl, wantAudio) {
  if (busy) return null;
  busy = true;
  statusEl.textContent = "Listening…";
  try {
    const got = await record(wantAudio);
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
  if (!s || !s.total) { $("stats").textContent = ""; return; }
  $("stats").textContent = "Right first time: " + s.last10_right + " of the last " + s.last10 + " tries (" + s.right + " of " + s.total + " in all).";
}

/** A person told us what the sound was. Learn from it, log it, and send it. */
async function settle(guess, meaning, attempt) {
  $("result-actions").replaceChildren();
  addExample(meaning, attempt.print);
  if (attempt.heard) {
    const votes = heardVotes[attempt.heard] || (heardVotes[attempt.heard] = {});
    votes[meaning] = (votes[meaning] || 0) + 1;
    save(HEARD, heardVotes);
  }
  showStats(await post("/api/sound-log", { guess, meaning, score: attempt.score, heard: attempt.heard, sure: attempt.sure }));
  const sent = await post("/gesture", { gesture: meaning, confidence: guess === meaning ? attempt.score : null, via: "sound" });
  $("result-detail").textContent = sent.ok ? "Sent to Messages. Epsilon will remember this sound." : (sent.error || "Could not send.");
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
  $("result").hidden = false;
  $("result-heard").textContent = "";
  $("result-text").textContent = m.sure ? "This may mean: " + label(m.meaning) : "Not sure what that was.";
  $("result-detail").textContent = m.meaning
    ? "Closest taught sound: " + label(m.meaning) + " (" + attempt.score.toFixed(2) + ", next best " + m.runnerUp.toFixed(2) + ")."
    : "No sounds are taught yet. Teach a few first.";

  const actions = $("result-actions");
  actions.replaceChildren();
  const choice = (text, meaning, primary) => {
    const b = el("button", "btn" + (primary ? " btn-primary" : ""), text);
    b.type = "button";
    b.onclick = () => settle(m.sure ? m.meaning : null, meaning, attempt);
    actions.append(b);
  };
  if (m.sure) choice("Yes, send " + label(m.meaning), m.meaning, true);
  Object.keys(words).filter((w) => !(m.sure && w === m.meaning)).forEach((w) => choice("It was " + label(w), w, false));
  const none = el("button", "btn", "It was nothing");
  none.type = "button";
  none.onclick = () => { $("result").hidden = true; };
  actions.append(none);

  if (got.audio) {
    $("result-heard").textContent = "Asking Deepgram…";
    const d = await post("/api/transcribe", got.audio, true);
    attempt.heard = (d.text || "").trim().toLowerCase();
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
  renderTeach();
}).catch(() => { $("teach-error").textContent = "Could not load the list of meanings from the hub."; });
fetch(withKey("/api/sound-log")).then((r) => r.json()).then(showStats).catch(() => {});
