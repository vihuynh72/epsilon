// Band voice: record a few seconds from the band's own microphone and let Gemini and Deepgram work out what was said.
// A separate page from the band page, so it cannot break gesture recognition. Server strings: textContent only.
import { Band, BandAudio } from '../../../vexo-open-kit/js/src/index.js';

const $ = (id) => document.getElementById(id);
const SECONDS = 5, RATE = 16000;
const label = (w) => w.charAt(0).toUpperCase() + w.slice(1);
let band = null, words = [], urgent = [], busy = false, lastTap = 0;
const SURE = 0.85;   // send without asking only when Gemini is at least this sure
const EMERGENCY_MS = 120000;  // after an emergency, keep listening for at most this long
let emergency = 0;   // when emergency listening started, or 0

try { $('number').value = new URLSearchParams(location.search).get('band') || localStorage.getItem('epsilon-band') || '44'; } catch { $('number').value = '44'; }
fetch('/api/info').then((r) => r.json()).then((i) => {
  words = i.messages.map((m) => m.id);
  urgent = i.messages.filter((m) => m.urgent).map((m) => m.id);
}).catch(() => {});

function button(text, primary, onclick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn' + (primary ? ' btn-primary' : '');
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

async function post(url, body, type) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': type || 'application/json' }, body: type ? body : JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, error: 'Could not reach Epsilon.' }; }
}

function wav(chunks) {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, n * 2, true);
  let at = 44;
  for (const c of chunks) for (const v of c) { view.setInt16(at, Math.max(-1, Math.min(1, v)) * 32767, true); at += 2; }
  return new Blob([view], { type: 'audio/wav' });
}

$('connect').onclick = async () => {
  const n = Number($('number').value.trim());
  if (!(n >= 1 && n <= 999)) { $('state').textContent = 'Type your band number first (1 to 999).'; return; }
  try {
    $('state').textContent = 'Connecting… pick your band in the list.';
    band = await Band.connect(n, $('link').value === 'ble' ? {} : { transport: $('link').value });
    try { localStorage.setItem('epsilon-band', String(n)); } catch { /* private window */ }
    $('state').textContent = 'Connected to ' + band.name + '.';
    $('listen').disabled = false;
    // Tap to speak: one tap on the band starts listening. Tap again for the next message.
    await band.configure({ events: true });
    const onTap = () => {
      if (Date.now() - lastTap < 1500) return;
      lastTap = Date.now();
      if (emergency) { emergency = 0; $('status').textContent = 'Stopped by a tap. Tap again to speak.'; return; } // the wearer says: enough
      listen();
    };
    band.on('tap', onTap);
    band.on('double-tap', onTap);
    $('status').textContent = 'Ready. Tap the band, then speak.';
    band.on('disconnect', () => { $('state').textContent = 'The band disconnected. Connect again.'; $('listen').disabled = true; });
  } catch (e) {
    $('state').textContent = e.message; // the kit's messages say what to do next
  }
};

async function send(body, done) {
  $('result-actions').replaceChildren();
  const r = await post('/gesture', body);
  const e = r.event || {};
  $('result-detail').textContent = !r.ok ? (r.error || 'Could not send.')
    : e.action === 'held' ? 'Not sent. ' + (e.reason || '') : (e.action === 'call' ? 'Sent as an emergency. ' : 'Sent. ') + done;
}

async function light(colour) {  // a short flash on the band: green = sent, amber = not sent
  try { await band.setLed(colour, { pattern: 'flash', period: 300 }); setTimeout(() => band.ledOff().catch(() => {}), 1500); } catch { /* light busy */ }
}

$('listen').onclick = () => listen();

async function listen() {
  if (busy || !band) return;
  busy = true;
  try { await listenOnce(); } finally { busy = false; }
}

async function listenOnce() {
  const chunks = [];
  let sound, stop;
  $('listen').disabled = true;
  $('result').hidden = true;
  try {
    sound = new BandAudio((samples) => chunks.push(Float32Array.from(samples)));
    stop = band.on('audio', (a) => sound.push(a));
    await band.configure({ audio: true });
    $('status').textContent = 'Listening through the band… speak now.';
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
  } catch (e) {
    $('status').textContent = e.message;
  } finally {
    try { await band.configure({ audio: false }); } catch { /* the link dropped */ }
    if (stop) stop();
    if (sound) sound.close();
    $('listen').disabled = false;
  }
  if (!chunks.length) { $('status').textContent = $('status').textContent || 'No sound came from the band.'; return; }
  // Silence must never become a message: on a silent recording a model can still name a word.
  let sum = 0, count = 0;
  for (const c of chunks) { for (const v of c) sum += v * v; count += c.length; }
  if (Math.sqrt(sum / Math.max(1, count)) < 0.01) { $('status').textContent = 'Nothing was heard. Tap the band and speak closer to it.'; light('#ff9f0a'); return; }

  $('status').textContent = 'Gemini and Deepgram are listening…';
  const clip = wav(chunks);
  const [d, g] = await Promise.all([post('/api/transcribe', clip, 'audio/wav'), post('/api/guess', clip, 'audio/wav')]);
  $('status').textContent = '';
  const said = (d.text || '').trim();
  const word = g.ok && g.word !== 'unsure' && words.includes(g.word) ? g.word : null;
  $('result').hidden = false;
  $('result-text').textContent = word ? 'This may be: ' + label(word) : said ? '“' + said + '”' : 'Not sure what that was.';
  $('result-detail').textContent = (said ? 'Deepgram wrote “' + said + '”. ' : 'Deepgram heard no words. ')
    + (g.ok ? 'Gemini heard “' + (g.heard || '?') + '”' + (word ? ' (' + Math.round(g.confidence * 100) + '% sure).' : '.') : '');
  const actions = $('result-actions');
  actions.replaceChildren();
  if (word) actions.append(button('Yes, send ' + label(word), true, async () => {
    // an emergency carries the person's own recording
    const own = urgent.includes(word) ? (await post('/api/clip', clip, 'audio/wav')).audio || null : null;
    send({ gesture: word, via: 'voice', confidence: g.confidence, audio: own }, 'Open Messages to see it.');
  }));
  if (said) actions.append(button('Send what was said', !word, () => send({ gesture: 'spoken', text: said, via: 'voice' }, 'Open Messages to see it.')));
  actions.append(button('It was nothing', false, () => { $('result').hidden = true; }));
  // Hands-free: a word Gemini is sure of goes straight out, so the wearer only taps and speaks.
  // two signals must agree: the model's pick, and either the word itself or a taught sound in what was written down
  if ($('auto').checked && word && g.confidence >= SURE && g.agreed) {
    const own = urgent.includes(word) ? (await post('/api/clip', clip, 'audio/wav')).audio || null : null;
    await send({ gesture: word, via: 'voice', confidence: g.confidence, audio: own }, 'Tap the band to speak again.');
    light('#00ff00');
    if (urgent.includes(word)) { emergency = Date.now(); setTimeout(keepListening, 400); }
  } else {
    light('#ff9f0a');
  }
  $('status').textContent = 'Tap the band to speak again.';
}

// After an emergency: keep listening in short turns and pass on anything that is said, so the parent is not
// left guessing. It ends when the wearer taps the band, the parent checks in, or two minutes have passed.
async function keepListening() {
  const started = emergency;
  while (emergency === started && Date.now() - started < EMERGENCY_MS && band) {
    const safe = await fetch('/api/safe').then((r) => r.json()).catch(() => ({}));
    if ((safe.safe_at || 0) * 1000 > started) { $('status').textContent = 'The parent checked in. Listening has stopped.'; break; }
    const chunks = [];
    let sound, stop;
    busy = true;
    try {
      sound = new BandAudio((samples) => chunks.push(Float32Array.from(samples)));
      stop = band.on('audio', (a) => sound.push(a));
      await band.configure({ audio: true });
      $('status').textContent = 'Emergency: still listening. Tap the band to stop.';
      await new Promise((r) => setTimeout(r, SECONDS * 1000));
    } catch { /* the link dropped: the loop ends below */ } finally {
      try { await band.configure({ audio: false }); } catch { emergency = 0; }
      if (stop) stop();
      if (sound) sound.close();
      busy = false;
    }
    if (emergency !== started) break;   // tapped while listening
    let sum = 0, count = 0;
    for (const c of chunks) { for (const v of c) sum += v * v; count += c.length; }
    if (!count || Math.sqrt(sum / count) < 0.01) continue;   // silence is never sent
    const said = ((await post('/api/transcribe', wav(chunks), 'audio/wav')).text || '').trim();
    if (said) await post('/gesture', { gesture: 'spoken', text: 'After the emergency: ' + said, via: 'voice' });
  }
  if (emergency === started) { emergency = 0; if (!/checked in/.test($('status').textContent)) $('status').textContent = 'Emergency listening ended. Tap the band to speak.'; }
}
