// Epsilon band page: connect -> teach the 5 words (guided) -> use. The word goes to the
// server (hub/server.py), which hands it on to the guardian's app.
//
// Using it:  pause, gesture, pause -> "Water" with a 2 s bar (double-tap the band to cancel)
//            -> sent, the band flashes green. 3 quick taps send Help at once.
// The gesture maths is in gestures.js; this file is only the page and the band.
import { $, say, attempt, onConnect } from '../../../vexo-open-kit/projects/shared/page.js';
import { MotionReader, toShape, classify, sameGesture, clashes, parseExamples, TapCounter, MAX_EXAMPLES, GYRO_SCALE, LIN_SCALE } from './gestures.js';
import { PRETEND } from './pretend-motions.js';

const BAND = 44;                  // the team's band, Vexo-HACK-44. The only place the number is written.
const EXAMPLES = 3;               // examples per word while teaching
const MAX_LEARNED = 4;            // examples per word picked up while in use
const CONFIRM_MS = 2000;          // time to cancel before a word is sent
const STORE = 'epsilon-examples-v2';

$('#number').value = String(BAND);
$('#tolerance').value = '1';

const info = await fetch('/api/info').then((r) => r.json()).catch(() => null);
if (!info) say('The server is not running: start  python3 hub/server.py  and open http://localhost:8000/');
const WORDS = info?.messages ?? [];
const IDS = WORDS.map((w) => w.id);
const word = (id) => WORDS.find((w) => w.id === id);
$('#feed-url').textContent = info?.feed_url ?? '?';

// --- examples: taught (guided) + learned (from sent gestures), kept in this browser -------
let taught, learned;
function load() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE)); } catch { /* nothing yet */ }
  taught = parseExamples(JSON.stringify(stored?.taught ?? null), IDS);
  learned = parseExamples(JSON.stringify(stored?.learned ?? null), IDS);
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ taught, learned })); } catch { /* private window: memory only */ }
}
const all = () => Object.fromEntries(IDS.map((id) => [id, [...taught[id], ...learned[id]]]));
const isTaught = (id) => taught[id].length > 0;
const tolerance = () => Number($('#tolerance').value) || 1;
load();

// --- state -------------------------------------------------------------------------------
const reader = new MotionReader();
const taps = new TapCounter();
let band = null;
let teaching = null;              // { queue, i, draft, back }
let pending = null;               // { id, shape, timer }
let quietUntil = 0;
let ledTimer = null, cardTimer = null;

function log(line) {
  const el = $('#log');
  el.textContent = `${new Date().toLocaleTimeString()}  ${line}\n` + el.textContent.split('\n').slice(0, 60).join('\n');
}
function view(name) {
  for (const v of ['connect', 'teach', 'use']) $(`#${v}-view`).hidden = v !== name;
}
function light(colour, opts = {}, ms = 0, then = null) {
  if (!band) return;
  clearTimeout(ledTimer);
  attempt(colour ? band.setLed(colour, opts) : band.ledOff());
  if (ms) ledTimer = setTimeout(() => (then ? then() : band && attempt(band.ledOff())), ms);
}

// --- teach: one word at a time, checked as you go ------------------------------------------
function teach(queue, back = 'use') {
  cancel(false);
  teaching = { queue, i: 0, draft: [], back };
  view('teach');
  beginWord();
}
function beginWord() {
  const id = teaching.queue[teaching.i];
  teaching.draft = [];
  note('');
  drawTeach();
  light('#ffffff', { pattern: 'breathe', period: 1500 });
  log(`teach ${id}`);
}
function drawTeach() {
  const id = teaching.queue[teaching.i], w = word(id);
  $('#teach-step').textContent = teaching.queue.length > 1 ? `Word ${teaching.i + 1} of ${teaching.queue.length}` : 'Teach again';
  $('#teach-icon').textContent = w.icon;
  $('#teach-title').textContent = `Show me “${w.label}”`;
  const dots = $('#teach-dots');
  dots.textContent = '';
  for (let k = 0; k < EXAMPLES; k++) {
    const dot = document.createElement('span');
    if (k < teaching.draft.length) dot.className = 'done';
    dots.append(dot);
  }
}
function note(text, kind = '') {
  $('#teach-note').textContent = text;
  $('#teach-note').className = `note ${kind}`;
}
const breathe = () => light('#ffffff', { pattern: 'breathe', period: 1500 });

function teachGesture(shape) {
  const id = teaching.queue[teaching.i];
  const same = sameGesture(shape, teaching.draft);
  if (!same.ok) {
    log(`  different from the others (${same.distance.toFixed(2)}): not kept`);
    note('That one looked different. Do it the same way as before.', 'bad');
    light('#ff3b30', { pattern: 'solid' }, 600, breathe);
    return;
  }
  teaching.draft.push(shape);
  drawTeach();
  log(`  example ${teaching.draft.length} ok${teaching.draft.length > 1 ? ` (${same.distance.toFixed(2)})` : ''}`);
  if (teaching.draft.length < EXAMPLES) {
    note(teaching.draft.length === 1 ? 'Good. Again.' : 'Good. Once more.', 'good');
    light('#00ff00', { pattern: 'solid' }, 300, breathe);
    return;
  }
  // Three good examples: would this word get mixed up with another one?
  const others = all();
  const trial = { ...others, [id]: teaching.draft };
  const mixed = clashes(id, trial, { tolerance: tolerance() }).filter((o) => others[o].length);
  if (mixed.length) {
    log(`  clashes with ${mixed.join(', ')}: again`);
    note(`Too much like “${word(mixed[0]).label}”. Try a more different movement.`, 'bad');
    teaching.draft = [];
    drawTeach();
    light('#ff3b30', { pattern: 'blink', period: 300 }, 900, breathe);
    return;
  }
  taught[id] = teaching.draft;
  learned[id] = [];
  save();
  note('Got it ✓', 'good');
  light('#00ff00', { pattern: 'flash', period: 250 }, 900);
  setTimeout(nextWord, 900);
}
function nextWord() {
  if (!teaching) return;
  teaching.i++;
  if (teaching.i < teaching.queue.length) return beginWord();
  teaching = null;
  light(null);
  use(IDS.every(isTaught) ? 'All set. Make one of your gestures.' : 'Make one of your gestures.');
}
$('#teach-redo').onclick = () => teaching && beginWord();
$('#teach-skip').onclick = () => nextWord();

// --- use ---------------------------------------------------------------------------------
function use(hint = 'Make one of your gestures.') {
  view('use');
  card({ icon: '👋', title: 'Ready', hint });
  tiles();
}
/** The big card. `colour` colours its border; `bar` runs the cancel countdown. */
function card({ icon, title, hint = '', colour = '', state = '', bar = false, back = 0 }) {
  clearTimeout(cardTimer);
  $('#card-icon').textContent = icon;
  $('#card-title').textContent = title;
  $('#card-hint').textContent = hint;
  $('#card').className = `word-card ${state}`;
  $('#card').style.setProperty('--word', colour || 'var(--line)');
  $('#bar').hidden = !bar;
  $('#cancel').hidden = !bar;
  if (bar) {
    const fill = $('#bar-fill');
    fill.style.transition = 'none';
    fill.style.width = '100%';
    void fill.offsetWidth;                                   // start the animation from full
    fill.style.transition = `width ${CONFIRM_MS}ms linear`;
    fill.style.width = '0%';
  }
  if (back) cardTimer = setTimeout(() => card({ icon: '👋', title: 'Ready', hint: 'Make one of your gestures.' }), back);
}
function tiles(active = null) {
  const box = $('#tiles');
  box.textContent = '';
  for (const w of WORDS) {
    const b = document.createElement('button');
    b.className = `tile${isTaught(w.id) ? '' : ' untaught'}`;
    if (active === w.id) b.style.borderColor = w.colour;
    const icon = document.createElement('b');
    icon.textContent = w.icon;
    b.append(icon, w.label);
    b.title = isTaught(w.id) ? `Teach “${w.label}” again` : `Teach “${w.label}”`;
    b.onclick = () => band && teach([w.id]);
    b.disabled = !band;
    box.append(b);
  }
}

function useGesture(shape) {
  if (pending || Date.now() < quietUntil) return;
  const got = classify(shape, all(), { tolerance: tolerance() });
  const near = got.ranked.slice(0, 3).map((r) => `${r.id} ${r.score.toFixed(2)}`).join(', ');
  log(`gesture -> ${got.id ?? `not sure (${got.reason})`}   [${near}]`);
  if (got.id) return propose(got.id, shape);
  if (got.reason === 'none') return;
  card({ icon: '🤔', title: 'Didn’t catch that', hint: 'Try again: pause, gesture, pause.', state: 'unsure', back: 2500 });
  light(null);
}
function propose(id, shape) {
  const w = word(id);
  pending = { id, shape, timer: setTimeout(() => { const p = pending; pending = null; send(p.id, 'gesture', p.shape); }, CONFIRM_MS) };
  card({ icon: w.icon, title: w.label, hint: 'Sending… double-tap the band to cancel.', colour: w.colour, bar: true });
  tiles(id);
  light(w.colour, { pattern: 'solid' });
}
function cancel(tell = true) {
  if (!pending) return;
  clearTimeout(pending.timer);
  log(`cancelled ${pending.id}`);
  pending = null;
  taps.reset();
  if (tell) { card({ icon: '✋', title: 'Cancelled', state: 'unsure', back: 1500 }); tiles(); }
  light(null);
}
$('#cancel').onclick = () => cancel();

async function send(id, via, shape = null) {
  const w = word(id);
  try {
    const r = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Epsilon': '1' },
      body: JSON.stringify({ id, via }),
    });
    if (!r.ok) throw new Error(`server said ${r.status}`);
    log(`SENT ${id} (${via})`);
    card({ icon: w.icon, title: `${w.label}: sent ✓`, hint: `“${w.phrase}”`, colour: w.colour, state: 'sent', back: 3000 });
    light('#00ff00', { pattern: 'flash', period: 300 }, 1500);
    recent(`${w.icon} ${w.label}`);
    if (shape && $('#learn').checked) keep(id, shape);
  } catch (e) {
    log(`send failed ${id}: ${e.message}`);
    card({ icon: '⚠️', title: `${w.label}: not sent`, hint: 'Is the server still running?', state: 'unsure', back: 4000 });
    light('#ff0000', { pattern: 'blink', period: 300 }, 1500);
  }
  tiles();
}
/** A sent, not cancelled gesture becomes an extra example: the page gets used to the wearer. */
function keep(id, shape) {
  learned[id].push(shape);
  while (learned[id].length > MAX_LEARNED || taught[id].length + learned[id].length > MAX_EXAMPLES) learned[id].shift();
  save();
}
function recent(text) {
  const li = document.createElement('li');
  const what = document.createElement('span');
  what.textContent = text;
  const when = document.createElement('span');
  when.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  li.append(what, when);
  $('#recent').prepend(li);
  while ($('#recent').children.length > 5) $('#recent').lastChild.remove();
}

function onTap(kind) {
  log(kind);
  if (teaching || !band) return;
  if (kind === 'double-tap' && pending) return cancel();
  if (taps.feed(kind) && $('#tap-help').checked) {
    cancel(false);
    quietUntil = Date.now() + 1500;                 // the taps are motion too: do not read them as a gesture
    send('help', 'taps');
  }
}

function onGesture(gesture) {
  draw(gesture);
  const shape = toShape(gesture);
  if (teaching) teachGesture(shape);
  else if (!$('#use-view').hidden) useGesture(shape);
}

// --- replies from the guardian's app ---------------------------------------------------------
if (info) {
  new EventSource('/api/events').addEventListener('ack', (e) => {
    const a = JSON.parse(e.data);
    log(`guardian: ${a.text}`);
    if (!teaching) card({ icon: '💬', title: a.text, hint: 'The guardian replied.', state: 'sent', back: 4000 });
    light('#00ff00', { pattern: 'breathe', period: 1000 }, 4000);
  });
}

// --- details ----------------------------------------------------------------------------------
const LINES = { lx: '#ff5c5c', ly: '#5cd65c', lz: '#5c9dff', gx: '#ffa13d', gy: '#c77dff', gz: '#3dd6d6' };
function draw(gesture) {
  const canvas = $('#picture'), pen = canvas.getContext('2d'), { width, height } = canvas;
  pen.clearRect(0, 0, width, height);
  const start = gesture[0].t, length = Math.max(1, gesture.at(-1).t - start);
  pen.lineWidth = 2;
  for (const [axis, colour] of Object.entries(LINES)) {
    const scale = axis[0] === 'g' ? GYRO_SCALE * 2 : LIN_SCALE * 3;
    pen.strokeStyle = colour;
    pen.beginPath();
    for (const s of gesture) pen.lineTo(10 + ((s.t - start) / length) * (width - 20), height / 2 - (s[axis] / scale) * (height / 2 - 8));
    pen.stroke();
  }
}
$('#reset').onclick = () => {
  if (!confirm('Forget every recorded gesture?')) return;
  taught = parseExamples(null, IDS);
  learned = parseExamples(null, IDS);
  save();
  if (band) teach(IDS);
};

// --- connecting -------------------------------------------------------------------------------
function bandState(text, on = false) {
  $('#band-state').textContent = `Band ${BAND} · ${text}`;
  $('#band-state').className = `pill${on ? ' on' : ''}`;
}
view('connect');

onConnect(async (theBand, pretend) => {
  band = theBand;
  band.on('motion', (sample) => {
    const gesture = reader.feed(sample);
    if (gesture) onGesture(gesture);
  });
  band.on('tap', () => onTap('tap'));
  band.on('double-tap', () => onTap('double-tap'));
  band.on('reconnecting', () => { reader.reset(); cancel(false); bandState('reconnecting…'); });
  band.on('reconnected', () => { bandState('connected', true); if (teaching) breathe(); else light(null); });
  band.on('disconnect', () => {
    band = null;
    reader.reset();
    cancel(false);
    teaching = null;
    bandState('not connected');
    view('connect');
  });

  if (pretend) {
    pretend.playMotion([{}]);                        // the pretend hand rests between motions
    const box = $('#pretend-moves');
    box.textContent = '';
    for (const [name, [shape, seconds]] of Object.entries(PRETEND)) {
      const b = document.createElement('button');
      b.textContent = name;
      b.id = `pretend-${name}`;
      b.onclick = () => { pretend.playMotion(shape, { seconds }); pretend.playMotion({}, { seconds: 0.6 }); };
      box.append(b, ' ');
    }
    $('#pretend-tap').disabled = $('#pretend-double').disabled = false;
    $('#pretend-tap').onclick = () => pretend.tap('tap');
    $('#pretend-double').onclick = () => pretend.tap('double-tap');
  }

  // 208 samples a second, averaged down in the page: cleaner than the band's 50/s, which
  // just picks every fourth sample. Falls back to 50/s where the link cannot do 208.
  try {
    await band.configure({ motion: 208, sensors: 'both', events: true });
    log('motion: 208/s, filtered to 50/s');
  } catch (e) {
    await band.configure({ motion: 50, events: true });
    log(`motion: 50/s (${e.message})`);
  }
  if (band.number !== BAND) {                        // Band.connect(44) already checks; belt and braces
    await band.disconnect();
    throw new Error(`That is band ${band.number}, not ${BAND}. Disconnected.`);
  }
  say('');
  bandState('connected', true);
  const missing = IDS.filter((id) => !isTaught(id));
  if (missing.length) teach(missing);
  else use();
});
