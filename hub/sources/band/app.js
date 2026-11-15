// Epsilon band page: connect -> calibrate (once) -> teach the 5 words -> use.
// The word goes to the server (hub/server.py), which hands it on to the guardian's app.
//
// Calibrate:  hold still, tap 5x slowly, tap 5x fast, move normally: the page learns this
//             wearer's taps (how hard, how fast, how long a gap ends a sequence).
// Teach:      "Pause 3 2 1" -> "Go!" -> whatever the band does is the example: an arm movement
//             or a number of taps. 3 tries per word.
// Use:        a movement or a tap sequence -> "Water" with a 1.5 s bar (2 taps cancel) -> sent,
//             the band flashes green. 3 taps send Help if no word uses 3 taps.
// The maths is in gestures.js; this file is only the page and the band.
import { $, say, attempt, onConnect } from '../../../vexo-open-kit/projects/shared/page.js';
import {
  MotionReader, TapDetector, TapSequencer, TAP_DEFAULTS, calibrate, toShape, classify, clashes, confidenceOf, bigEnough,
  cutWindow, isBusy, tapsOnly, parseExamples, MAX_EXAMPLES, GYRO_SCALE, LIN_SCALE,
} from './gestures.js';
import { PRETEND, PRETEND_TAP } from './pretend-motions.js';
import { Recorder } from './recorder.js';
import { icon } from './icons.js';

// Hosted without the server (e.g. on Vercel): no messaging; each person types their own band number.
const info = await fetch('/api/info').then((r) => (r.ok ? r.json() : null)).catch(() => null);
const HOSTED = !info;
const savedBand = (() => { try { return Number(localStorage.getItem('epsilon-band')) || null; } catch { return null; } })();
let BAND = HOSTED ? savedBand : 44;   // with the server: the team's band, Vexo-HACK-44
const EXAMPLES = 3;               // tries per word while teaching
const MAX_LEARNED = 4;            // examples per word picked up while in use
const CONFIRM_MS = 1500;          // time to cancel before a word is sent
const PAUSE_MS = 3000;            // teaching: the pause before each try
const GO_MS = 3500;               // teaching: the longest a movement try may take
const DONE_QUIET_MS = 400;        // teaching: still this long after moving = the try is over
const WAVE_MS = 4000;             // the live picture shows the last 4 seconds
const STORE = 'epsilon-examples-v3';      // v3: movements relative to the wearer (v2 movements are not comparable)
const OLD_STORE = 'epsilon-examples-v2';  // its tap words carry over
const TAP_STORE = 'epsilon-taps-v1';

$('#number').value = BAND ? String(BAND) : ($('#number').value || '');   // ?band= in the address also works
// USB cable or Bluetooth (double-tap the band first), in the connect card
if (!new URLSearchParams(location.search).get('link')) {
  $('#link').hidden = false;
  $('#link').removeAttribute('aria-hidden');
  $('#link').className = 'band-link';
  $('#link').querySelector('option[value="pretend"]').hidden = true;
  $('#connect-view').insertBefore($('#link'), $('#connect'));
}
if (HOSTED) {
  $('#number').type = 'text';
  $('#number').placeholder = 'Band number';
  $('#number').inputMode = 'numeric';
  $('#number').className = 'band-number';
  $('#connect-view').insertBefore($('#number'), $('#connect'));
  $('#to-app-row').hidden = true;
  $('#number').addEventListener('change', () => { try { localStorage.setItem('epsilon-band', $('#number').value.trim()); } catch { /* private window */ } });
}
$('#tolerance').value = '1';

const WORDS = info?.messages ?? (await fetch('./words.json').then((r) => r.json()).catch(() => []));
if (!WORDS.length) say('No words: start the server with  python3 hub/server.py');
const IDS = WORDS.map((w) => w.id);
const word = (id) => WORDS.find((w) => w.id === id);
$('#feed-url').textContent = info?.feed_url ?? '?';

// --- "Send to the guardian app": off while teaching and testing, on when ready --------------------
const APP_STORE = 'epsilon-to-app';
const appHosts = info?.forward_to ?? [];
function showAppSwitch() {
  const on = $('#to-app').checked;
  $('#to-app-row').classList.toggle('on', on);
  $('#app-state').textContent = !appHosts.length ? 'Start the server with --forward to use this'
    : on ? appHosts.join(', ') : '';
}
$('#to-app').disabled = !appHosts.length;
try { $('#to-app').checked = appHosts.length > 0 && localStorage.getItem(APP_STORE) === 'on'; } catch { /* private window */ }
$('#to-app').onchange = () => {
  try { localStorage.setItem(APP_STORE, $('#to-app').checked ? 'on' : 'off'); } catch { /* private window */ }
  log(`send to the guardian app: ${$('#to-app').checked ? 'on' : 'off'}`);
  showAppSwitch();
};
showAppSwitch();

// --- what the page knows: movement examples, tap words, tap calibration ---------------------
let taught, learned, tapWords, tapSettings;
const read = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ } };
function load() {
  const stored = read(STORE);
  const old = stored ? null : read(OLD_STORE);
  taught = parseExamples(JSON.stringify(stored?.taught ?? null), IDS);
  learned = parseExamples(JSON.stringify(stored?.learned ?? null), IDS);
  tapWords = {};
  for (const id of IDS) {
    const n = (stored ?? old)?.tapWords?.[id];
    if (Number.isInteger(n) && n >= 1 && n <= 9) tapWords[id] = n;
  }
  const t = read(TAP_STORE);
  tapSettings = t && Object.keys(TAP_DEFAULTS).every((k) => Number.isFinite(t[k])) ? t : null;
}
const save = () => write(STORE, { taught, learned, tapWords });
const movements = () => Object.fromEntries(IDS.filter((id) => !tapWords[id]).map((id) => [id, [...taught[id], ...learned[id]]]));
const isTaught = (id) => taught[id].length > 0 || Boolean(tapWords[id]);
const wordForTaps = (n) => IDS.find((id) => tapWords[id] === n);
const tolerance = () => Number($('#tolerance').value) || 1;
const describe = (id) => (tapWords[id] ? `${tapWords[id]} tap${tapWords[id] > 1 ? 's' : ''}` : isTaught(id) ? 'movement' : 'not taught');
load();
const rec = new Recorder({ log: (l) => log(l), context: () => ({ band: BAND, taps: tapSettings, tolerance: tolerance(), words: Object.fromEntries(IDS.map((id) => [id, describe(id)])) }) });
try { rec.fullLog = localStorage.getItem('epsilon-full-log') !== 'off'; } catch { /* private window */ }
if (HOSTED) { rec.offline = true; rec.fullLog = false; }
$('#download').hidden = !HOSTED;
$('#download').onclick = () => rec.download();

// --- state -----------------------------------------------------------------------------------
const reader = new MotionReader(tapSettings ?? TAP_DEFAULTS);
let sequence = new TapSequencer(tapSettings ?? TAP_DEFAULTS);
let band = null;
let calib = null;                 // while calibrating
let teaching = null;              // while teaching
let pending = null;               // { id, shape, via, timer, taps } while waiting for a cancel
let ledTimer = null, cardTimer = null;
const tapMarks = [];              // band times of recent taps, for the waves

function log(line) {
  const el = $('#log');
  el.textContent = `${new Date().toLocaleTimeString()}  ${line}\n` + el.textContent.split('\n').slice(0, 80).join('\n');
}
function view(name) {
  for (const v of ['connect', 'calib', 'teach', 'use']) $(`#${v}-view`).hidden = v !== name;
}
function light(colour, opts = {}, ms = 0, then = null) {
  if (!band) return;
  clearTimeout(ledTimer);
  attempt(colour ? band.setLed(colour, opts) : band.ledOff());
  if (ms) ledTimer = setTimeout(() => (then ? then() : band && attempt(band.ledOff())), ms);
}
function useTapSettings(settings) {
  tapSettings = settings;
  reader.setTaps(settings);
  sequence = new TapSequencer(settings);
  const s = settings;
  log(`taps: threshold ${s.threshold.toFixed(2)} g, one tap rings ${Math.round(s.ringMs)} ms, a gap of ${Math.round(s.maxGapMs)} ms ends a sequence`);
}
if (tapSettings) useTapSettings(tapSettings);

/** Fill `box` with `n` dots, the first `done` of them filled. */
function dots(box, n, done) {
  box.textContent = '';
  for (let k = 0; k < n; k++) {
    const dot = document.createElement('span');
    if (k < done) dot.className = 'done';
    box.append(dot);
  }
}
function line(el, text, kind = '') {
  el.textContent = text;
  el.className = `${el.id.endsWith('phase') ? 'phase' : 'note'} ${kind}`;
}

// --- 1. calibrate: a short session, or the one-time reference recording -----------------------
// Every step: an optional "Get ready" countdown (not recorded), then a recorded window. Tap
// steps fill dots as taps are felt and end early once all were felt. Everything recorded is
// saved to data/recordings/ on this laptop, so it can be studied and used as test data.
const CALIB_STEPS = [
  { key: 'still', icon: '', title: 'Wear the band and rest your arm', hint: 'Calibrate on the wrist, not on a table', ms: 3000 },
  { key: 'slow', icon: '👆', title: 'Tap the band 5 times, slowly', hint: 'About one tap a second.', taps: 5, ms: 9000 },
  { key: 'fast', icon: '⚡', title: 'Now tap 5 times, quickly', hint: 'As fast as feels natural.', taps: 5, ms: 6000 },
  { key: 'move', icon: '👋', title: 'Now move your arm around', hint: 'Like usual, no taps', ms: 4000 },
];
const MOVES = [
  ['left', '⬅️', 'Move your hand to the left'], ['right', '➡️', 'Move your hand to the right'],
  ['up', '⬆️', 'Move your hand up'], ['down', '⬇️', 'Move your hand down'],
  ['forward', '⏫', 'Push your hand forward, away from you'], ['back', '⏬', 'Pull your hand back, toward you'],
  ['twist', '🔄', 'Twist your wrist and back'], ['circle', '⭕', 'Draw a circle in the air'],
];
const REFERENCE_STEPS = [
  { key: 'still', icon: '✋', title: 'Wear the band and rest your arm', hint: 'Record on the wrist, not on a table', ms: 4000 },
  { key: 'still-air', icon: '🖐️', title: 'Hold your arm up in front of you', hint: 'Keep it still.', ready: 2000, ms: 4000 },
  { key: 'soft', icon: '🪶', title: 'Tap 5 times, softly', hint: 'The softest tap you would use.', taps: 5, ms: 9000 },
  { key: 'hard', icon: '💥', title: 'Tap 5 times, hard', hint: 'A firm tap.', taps: 5, ms: 9000 },
  { key: 'slow', icon: '👆', title: 'Tap 5 times, slowly', hint: 'About one tap a second.', taps: 5, ms: 9000 },
  { key: 'fast', icon: '⚡', title: 'Tap 5 times, quickly', hint: 'As fast as feels natural.', taps: 5, ms: 6000 },
  { key: 'pairs', icon: '✌️', title: 'Tap twice, pause. Three times.', hint: 'Two taps, a pause, three times over', taps: 6, ms: 10000 },
  { key: 'triples', icon: '🤟', title: 'Tap 3 times, pause. Three times.', hint: 'Three taps, a pause, three times over', taps: 9, ms: 12000 },
  ...MOVES.flatMap(([key, icon, title]) => [1, 2, 3].map((n) => ({ key: `${key}-${n}`, icon, title, hint: `${n} of 3. Then hold still.`, ready: 2000, ms: 2500 }))),
  { key: 'move', icon: '👋', title: 'Move around normally', hint: 'Like usual, no taps', ready: 1500, ms: 8000 },
];
function stopCalibration() {
  if (!calib) return;
  clearTimeout(calib.timer);
  clearInterval(calib.tick);
  calib = null;
}
function startCalibration(then, steps = CALIB_STEPS, name = 'calibration') {
  cancel(false);
  stopTeaching();
  teaching = null;                 // one mode at a time: calibration ends teaching
  stopCalibration();               // and a calibration already running
  clearTimeout(afterCalib);
  sequence.reset();
  calib = { i: -1, raw: {}, steps, name, then, timer: null, tick: null, recording: false };
  view('calib');
  light(null);
  nextCalibStep();
}
function countdown(ms, text, kind, done) {
  const session = calib, until = Date.now() + ms;
  const show = () => { if (calib === session) line($('#calib-phase'), text(Math.max(1, Math.ceil((until - Date.now()) / 1000))), kind); };
  show();
  session.tick = setInterval(show, 100);
  session.timer = setTimeout(() => { clearInterval(session.tick); if (calib === session) done(); }, ms);
}
function nextCalibStep() {
  clearTimeout(calib.timer);
  clearInterval(calib.tick);
  calib.recording = false;
  calib.i++;
  if (calib.i >= calib.steps.length) return finishCalibration();
  const step = calib.steps[calib.i];
  // Only to fill the dots as you tap, a little more sensitive than normal. The settings come
  // from calibrate(), which measures the raw recording afterwards.
  calib.detector = new TapDetector({ ...TAP_DEFAULTS, threshold: 0.3, calmGyro: 200 });
  calib.taps = 0;
  calib.step = step;
  $('#calib-step').textContent = `Step ${calib.i + 1} of ${calib.steps.length}`;
  $('#calib-icon').textContent = step.icon;
  $('#calib-title').textContent = step.title;
  $('#calib-hint').textContent = step.hint;
  dots($('#calib-dots'), step.taps ?? 0, 0);
  const record = () => {
    calib.raw[step.key] = [];
    calib.recording = true;
    light('#ffffff', { pattern: 'solid', brightness: 0.4 });
    countdown(step.ms, (n) => `${n}`, step.ready ? 'go' : 'wait', endCalibStep);
  };
  if (step.ready) { light(null); countdown(step.ready, (n) => `${n}`, 'wait', record); } else record();
}
function calibSample(sample) {
  if (!calib.recording || !calib.raw[calib.step?.key]) return;
  const r4 = (x) => Math.round(x * 1e4) / 1e4, r1 = (x) => Math.round(x * 10) / 10;
  calib.raw[calib.step.key].push([Math.round(sample.t * 10) / 10, r4(sample.ax), r4(sample.ay), r4(sample.az), r1(sample.gx), r1(sample.gy), r1(sample.gz)]);
  const tap = calib.detector.feed(sample);
  if (tap && calib.step.taps) {
    calib.taps++;
    dots($('#calib-dots'), calib.step.taps, calib.taps);
    if (calib.taps >= calib.step.taps) { clearTimeout(calib.timer); clearInterval(calib.tick); calib.timer = setTimeout(endCalibStep, 600); }
  }
}
function endCalibStep() {
  calib.recording = false;
  if (calib.step.taps) log(`${calib.name} ${calib.step.key}: felt ${calib.taps} of ${calib.step.taps} taps`);
  nextCalibStep();
}
/** Send the raw recording to the server (saved in data/recordings/, never leaves this laptop). */
function saveRecording(name, raw, settings) {
  if (HOSTED) return rec.keep(name, { band: BAND, columns: ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'], steps: raw, settings });
  fetch(`/api/recording?name=${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Epsilon': '1' },
    body: JSON.stringify({ band: BAND, columns: ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'], accelRange: 8, steps: raw, settings, at: new Date().toISOString() }),
  }).then((r) => r.json()).then((r) => log(`recording saved: ${r.saved}`), (e) => log(`recording not saved: ${e.message}`));
}
function finishCalibration() {
  const raw = calib.raw;
  const { settings, warnings, taps } = calibrate({ still: raw.still, slow: raw.slow, fast: raw.fast, move: raw.move, more: [raw.soft, raw.hard, raw.pairs, raw.triples].filter(Boolean) });
  log(`${calib.name} measured ${taps.slow} slow and ${taps.fast} fast taps`);
  const { then, name } = calib;
  calib = null;
  const felt = taps.slow + taps.fast;
  if (felt >= 6 || !tapSettings) {
    write(TAP_STORE, settings);
    useTapSettings(settings);
  } else {
    log(`calibration felt only ${felt} taps: the earlier settings are kept`);
  }
  saveRecording(name, raw, settings);
  rec.event({ kind: 'calibration', name, settings, warnings, taps });
  for (const w of warnings) log(`calibration: ${w}`);
  $('#calib-step').textContent = '';
  $('#calib-icon').textContent = '✓';
  $('#calib-title').textContent = name === 'reference' ? 'Recorded' : 'Calibrated';
  $('#calib-hint').textContent = warnings[0] ?? 'Taps are tuned to this wearer';
  dots($('#calib-dots'), 0, 0);
  line($('#calib-phase'), '');
  light('#00ff00', { pattern: 'flash', period: 250 }, 900);
  afterCalib = setTimeout(() => { if (band && !calib && !teaching) then(); }, warnings.length ? 3500 : 1500);
}
let afterCalib = null;
$('#calib-skip').onclick = () => {
  if (!calib) return;
  if (calib.step) calib.raw[calib.step.key] ??= [];
  if (calib.name === 'reference') return endCalibStep();          // skip just this step
  const then = calib.then;
  stopCalibration();
  then();
};
$('#calibrate').onclick = () => band && startCalibration(() => use());
$('#reference').onclick = () => band && startCalibration(() => use(), REFERENCE_STEPS, 'reference');

// --- 2. teach: one word at a time, on a timer --------------------------------------------------
function teach(queue) {
  cancel(false);
  stopTeaching();
  stopCalibration();               // one mode at a time: teaching ends calibration
  clearTimeout(afterCalib);
  sequence.reset();                // a tap from before must not fire a word afterwards
  teaching = { queue, i: 0, tries: [], phase: 'pause' };
  view('teach');
  beginWord();
}
function stopTeaching() {
  if (!teaching) return;
  clearTimeout(teaching.timer);
  clearInterval(teaching.tick);
}
function beginWord() {
  stopTeaching();
  teaching.tries = [];
  line($('#teach-note'), '');
  drawTeach();
  log(`teach ${teaching.queue[teaching.i]}`);
  pause();
}
function drawTeach() {
  const w = word(teaching.queue[teaching.i]);
  $('#teach-step').textContent = teaching.queue.length > 1 ? `Word ${teaching.i + 1} of ${teaching.queue.length}` : 'Teach again';
  $('#teach-icon').replaceChildren(icon(w.id, 40));
  $('#teach-title').textContent = w.label;
  dots($('#teach-dots'), EXAMPLES, teaching.tries.length);
}
/** "Pause 3… 2… 1…", then go(). The light is off: nothing is recorded. */
function pause() {
  teaching.phase = 'pause';
  const until = Date.now() + PAUSE_MS;
  const show = () => line($('#teach-phase'), `${Math.max(1, Math.ceil((until - Date.now()) / 1000))}`, 'wait');
  show();
  light(null);
  teaching.tick = setInterval(show, 100);
  teaching.timer = setTimeout(() => { clearInterval(teaching.tick); go(); }, PAUSE_MS);
}
/** "Go!": the light is white; everything the band does until it is still again is the try. */
function go() {
  Object.assign(teaching, { phase: 'go', capture: [], taps: [], moved: false, lastMove: 0, startedAt: Date.now() });
  line($('#teach-phase'), 'Now', 'go');
  light('#ffffff', { pattern: 'solid', brightness: 0.6 });
  teaching.timer = setTimeout(timeUp, GO_MS);
}
function timeUp() {
  // Taps still coming (slow taps): give them time, up to 3 s more.
  const lastTap = teaching.taps.at(-1) ?? -Infinity;
  const now = teaching.capture.at(-1)?.t ?? 0;
  if (now - lastTap < sequence.settings.maxGapMs && Date.now() - teaching.startedAt < GO_MS + 3000) {
    teaching.timer = setTimeout(timeUp, 200);
    return;
  }
  finishTry();
}
function teachStep(step) {
  if (teaching.phase !== 'go') return;
  teaching.capture.push(step);
  if (isBusy(step)) { teaching.moved = true; teaching.lastMove = step.t; }
  const lastTap = teaching.taps.at(-1) ?? -Infinity;
  const tapsOver = step.t - lastTap >= sequence.settings.maxGapMs;
  if (teaching.moved && step.t - teaching.lastMove >= DONE_QUIET_MS && tapsOver) finishTry();
}
function teachTap(tap) {
  if (teaching.phase !== 'go') return;
  teaching.taps.push(tap.t);
  line($('#teach-phase'), `${'● '.repeat(teaching.taps.length).trim()}`, 'go');
}
function finishTry() {
  if (!teaching || teaching.phase !== 'go') return;
  clearTimeout(teaching.timer);
  teaching.phase = 'pause';
  let tryOut = null;
  if (teaching.taps.length && tapsOnly(teaching.capture, teaching.taps, sequence.settings.ringMs, 300)) {
    tryOut = { taps: teaching.taps.length };
  } else {
    const cut = cutWindow(teaching.capture);
    if (cut) {
      const size = bigEnough(cut);
      if (!size.ok) {
        log(`  too small: ${Math.round(size.turnDeg)}°, ${size.speed.toFixed(3)} g·s`);
        rec.event({ kind: 'teach-small', word: teaching.queue[teaching.i], turnDeg: size.turnDeg, speed: size.speed }, [cut[0].t, cut.at(-1).t]);
        line($('#teach-note'), 'Too small. Make the movement bigger', 'bad');
        return pause();
      }
      tryOut = { shape: toShape(cut), ms: Math.round(cut.at(-1).t - cut[0].t) };
    }
  }
  if (!tryOut) {
    log('  nothing');
    line($('#teach-note'), 'No movement felt. Try again', 'bad');
    return pause();
  }
  rec.event({ kind: 'teach-try', word: teaching.queue[teaching.i], taps: tryOut.taps ?? null, ms: tryOut.ms ?? null }, teaching.capture.length ? [teaching.capture[0].t, teaching.capture.at(-1).t] : null);
  teaching.tries.push(tryOut);
  drawTeach();
  const what = tryOut.taps ? `${tryOut.taps} tap${tryOut.taps > 1 ? 's' : ''}` : 'a movement';
  log(`  try ${teaching.tries.length}: ${tryOut.taps ? what : `movement, ${tryOut.ms} ms`}`);
  if (teaching.tries.length < EXAMPLES) {
    line($('#teach-note'), `${what[0].toUpperCase()}${what.slice(1)} recorded, ${EXAMPLES - teaching.tries.length} to go`, 'good');
    light('#00ff00', { pattern: 'solid' }, 300);
    return pause();
  }
  finishWord();
}
function again(text) {
  log(`  ${text}`);
  rec.event({ kind: 'teach-redo', word: teaching.queue[teaching.i], reason: text });
  line($('#teach-note'), text, 'bad');
  teaching.tries = [];
  drawTeach();
  light('#ff3b30', { pattern: 'blink', period: 300 }, 900);
  pause();
}
function finishWord() {
  const id = teaching.queue[teaching.i];
  const tries = teaching.tries;
  const tapTries = tries.filter((t) => t.taps);
  if (tapTries.length && tapTries.length < tries.length) return again('Mixed taps and movements. Repeat the same thing each time');
  if (tapTries.length) {
    const counts = tapTries.map((t) => t.taps);
    if (new Set(counts).size > 1) return again(`Counted ${counts.slice(0, -1).join(', ')} and ${counts.at(-1)} taps. Use the same number each time`);
    const n = counts[0];
    const other = IDS.find((o) => o !== id && tapWords[o] === n);
    if (other) return again(`${n} tap${n > 1 ? 's' : ''} already means ${word(other).label}. Use a different number`);
    tapWords[id] = n;
    taught[id] = [];
    learned[id] = [];
  } else {
    const shapes = tries.map((t) => t.shape);
    const others = movements();
    delete others[id];
    const mixed = clashes(id, { ...others, [id]: shapes }, { tolerance: tolerance() }).filter((o) => others[o]?.length);
    if (mixed.length) return again(`Too close to ${word(mixed[0]).label}. Use a different movement`);
    taught[id] = shapes;
    learned[id] = [];
    delete tapWords[id];
  }
  save();
  rec.event({ kind: 'teach-word', word: id, as: describe(id) });
  line($('#teach-phase'), `Saved: ${describe(id)}`, 'go');
  line($('#teach-note'), '');
  light('#00ff00', { pattern: 'flash', period: 250 }, 900);
  teaching.timer = setTimeout(nextWord, 1100);
}
function nextWord() {
  if (!teaching) return;
  stopTeaching();
  teaching.i++;
  if (teaching.i < teaching.queue.length) return beginWord();
  teaching = null;
  light(null);
  use();
}
$('#teach-redo').onclick = () => teaching && beginWord();
$('#teach-skip').onclick = () => nextWord();

// --- 3. use ---------------------------------------------------------------------------------------
const READY = { icon: '', title: 'Ready', hint: '' };
function use(hint = READY.hint) {
  view('use');
  card({ ...READY, hint });
  tiles();
}
/** The big card. `colour` colours its border; `bar` runs the cancel countdown. */
function card({ icon: id = null, title, hint = '', colour = '', state = '', bar = false, back = 0 }) {
  clearTimeout(cardTimer);
  $('#card-icon').replaceChildren(...(id ? [icon(id, 48)] : []));
  $('#card-title').textContent = title;
  $('#card-hint').textContent = hint;
  $('#card').className = `word-card ${state}`;
  $('#card').style.setProperty('--word', colour || 'var(--border)');
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
  if (back) cardTimer = setTimeout(() => card(READY), back);
}
function tiles(active = null) {
  const box = $('#tiles');
  box.textContent = '';
  for (const w of WORDS) {
    const b = document.createElement('button');
    b.className = `tile${isTaught(w.id) ? '' : ' untaught'}`;
    if (active === w.id) b.style.borderColor = w.colour;
    const how = document.createElement('small');
    how.textContent = describe(w.id);
    b.append(icon(w.id, 22), w.label, how);
    b.title = `Teach ${w.label} again`;
    b.onclick = () => band && teach([w.id]);
    b.disabled = !band;
    box.append(b);
  }
}
const inUse = () => !teaching && !calib && !$('#use-view').hidden;

let lastSpan = null, lastEvent = null;
function useGesture(shape) {
  if (pending) return;
  const got = classify(shape, movements(), { tolerance: tolerance() });
  const near = got.ranked.slice(0, 3).map((r) => `${r.id} ${r.score.toFixed(2)}`).join(', ');
  log(`movement -> ${got.id ?? `not sure (${got.reason})`}   [${near}]`);
  lastEvent = rec.event({ kind: 'movement', word: got.id, reason: got.reason ?? null, confidence: got.id ? confidenceOf(got) : null, ranked: got.ranked.slice(0, 3) }, lastSpan);
  if (got.id) return propose(got.id, shape, 'gesture', confidenceOf(got));   // the app holds back below 0.8
  if (got.reason === 'none') return;
  card({ icon: '', title: 'Not recognised', hint: '', state: 'unsure', back: 2500 });
  light(null);
}
function useTaps(n, times = []) {
  if (pending) return;
  const id = wordForTaps(n);
  lastEvent = rec.event({ kind: 'taps', count: n, times, word: id ?? null }, lastSpan);
  log(`${n} tap${n > 1 ? 's' : ''} -> ${id ?? (n === 3 && $('#tap-help').checked ? 'help (built in)' : 'no word')}`);
  if (id) return propose(id, null, 'taps', 1);            // a tap count is exact
  if (n === 3 && $('#tap-help').checked) return send('help', 'taps', null, 1);
  card({ icon: '', title: `${n} tap${n > 1 ? 's' : ''}`, hint: 'No word for this', state: 'unsure', back: 2500 });
}
function propose(id, shape, via, confidence) {
  const w = word(id);
  pending = { id, shape, via, of: lastEvent, taps: [], timer: setTimeout(() => { const p = pending; pending = null; send(p.id, p.via, p.shape, confidence, p.of); }, CONFIRM_MS) };
  sequence.reset();
  card({ icon: id, title: w.label, hint: 'Tap twice to cancel', colour: w.colour, bar: true });
  tiles(id);
  light(w.colour, { pattern: 'solid' });
}
function cancel(tell = true) {
  if (!pending) return;
  clearTimeout(pending.timer);
  log(`cancelled ${pending.id}`);
  rec.event({ kind: 'cancelled', of: pending.of, word: pending.id });
  pending = null;
  sequence.reset();
  if (tell) { card({ icon: '', title: 'Cancelled', state: 'unsure', back: 1500 }); tiles(); }
  light(null);
}
$('#cancel').onclick = () => cancel();

let sends = 0;
async function send(id, via, shape = null, confidence = null, of = lastEvent) {
  const w = word(id);
  const mine = ++sends;
  const current = () => mine === sends && !pending;     // nothing newer was proposed or sent meanwhile
  try {
    if (HOSTED) {                                  // no server: the word is shown, not sent anywhere
      log(`RECOGNISED ${id} (${via}${confidence === null ? '' : `, confidence ${confidence.toFixed(2)}`})`);
      rec.event({ kind: 'sent', of, word: id, via, confidence, forwarded: [] });
      if (current()) {
        card({ icon: id, title: w.label, hint: '', colour: w.colour, state: 'sent', back: 3000 });
        light('#00ff00', { pattern: 'flash', period: 300 }, 1500);
        tiles();
      }
      recent(w.label);
      if (shape && $('#learn').checked) keep(id, shape);
      return;
    }
    const r = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Epsilon': '1' },
      body: JSON.stringify({ id, via, confidence, forward: $('#to-app').checked }),
    });
    if (!r.ok) throw new Error(`server said ${r.status}`);
    const answer = await r.json().catch(() => ({}));
    const out = answer.forwarded ?? [];
    const failed = out.filter((f) => !f.ok);
    rec.event({ kind: 'sent', of, word: id, via, confidence, forwarded: out });
    log(`SENT ${id} (${via}${confidence === null ? '' : `, confidence ${confidence.toFixed(2)}`})${out.map((f) => `  ${f.ok ? '→' : '✗'} ${f.to}${f.ok ? '' : ` (${f.error ?? f.status})`}`).join('')}`);
    const where = !out.length ? ''
      : failed.length ? `Couldn’t reach the app: ${failed[0].error ?? failed[0].status}` : 'Delivered';
    if (current()) {
      card({ icon: id, title: w.label, hint: where, colour: w.colour, state: failed.length ? 'unsure' : 'sent', back: failed.length ? 5000 : 3000 });
      light(failed.length ? '#ff9f0a' : '#00ff00', { pattern: 'flash', period: 300 }, 1500);
    }
    recent(w.label);
    if (shape && $('#learn').checked) keep(id, shape);
  } catch (e) {
    log(`send failed ${id}: ${e.message}`);
    if (current()) {
      card({ icon: '', title: `${w.label} not sent`, hint: 'Couldn’t reach the server on this laptop', state: 'unsure', back: 4000 });
      light('#ff0000', { pattern: 'blink', period: 300 }, 1500);
    }
  }
  if (current()) tiles();
}
/** A sent, not cancelled movement becomes an extra example: the page gets used to the wearer. */
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

// --- every sample from the band -------------------------------------------------------------------
function onSample(sample) {
  rec.sample(sample);
  if (calib) calibSample(sample);
  const gesture = reader.feed(sample);
  if (reader.tap) onTap(reader.tap);
  if (reader.step && reader.step !== onSample.last) { onSample.last = reader.step; onStep(reader.step); }
  if (gesture && inUse()) { lastSpan = [gesture[0].t, gesture.at(-1).t]; useGesture(toShape(gesture)); }
  if (inUse() && !pending) {
    const done = sequence.tick(sample.t);
    if (done) { lastSpan = [done.times[0], done.times.at(-1) + 300]; useTaps(done.count, done.times); }
  }
}
function onTap(tap) {
  tapMarks.push(tap.t);
  while (tapMarks.length > 30) tapMarks.shift();
  if (calib) return;
  if (teaching) return teachTap(tap);
  if (!inUse()) return;
  if (pending) {                                   // two taps while a word waits = cancel, at once
    pending.taps = pending.taps.filter((t) => tap.t - t <= sequence.settings.maxGapMs);
    pending.taps.push(tap.t);
    if (pending.taps.length >= 2) cancel();
    return;
  }
  sequence.add(tap);
}

// --- replies from the guardian's app ------------------------------------------------------------------
if (info) {
  new EventSource('/api/events').addEventListener('ack', (e) => {
    const a = JSON.parse(e.data);
    log(`guardian: ${a.text}`);
    if (inUse()) card({ icon: '', title: a.text, hint: 'Reply from the guardian', state: 'sent', back: 4000 });
    light('#00ff00', { pattern: 'breathe', period: 1000 }, 4000);
  });
}

// --- the live waves -------------------------------------------------------------------------------------
const LINES = { lx: '#ff5c5c', ly: '#5cd65c', lz: '#5c9dff', gx: '#ffa13d', gy: '#c77dff', gz: '#3dd6d6' };
const waves = [];
function onStep(step) {
  const mark = teaching?.phase === 'go' ? 'go' : reader.reading ? 'reading' : '';
  waves.push({ ...step, mark });
  while (waves.length && step.t - waves[0].t > WAVE_MS) waves.shift();
  if (teaching) teachStep(step);
}
function drawWaves() {
  requestAnimationFrame(drawWaves);
  if ($('#waves').hidden || !waves.length) return;
  const canvas = $('#picture'), pen = canvas.getContext('2d'), { width, height } = canvas;
  const end = waves.at(-1).t, x = (t) => width - ((end - t) / WAVE_MS) * width;
  pen.clearRect(0, 0, width, height);
  for (const s of waves) {                                    // shade what is being recorded or read
    if (!s.mark) continue;
    pen.fillStyle = s.mark === 'go' ? 'rgba(255,255,255,0.10)' : 'rgba(47,111,237,0.25)';
    pen.fillRect(x(s.t), 0, Math.ceil(width / (WAVE_MS / 20)) + 1, height);
  }
  pen.fillStyle = 'rgba(255,255,255,0.85)';                   // a white line at every tap
  for (const t of tapMarks) if (end - t < WAVE_MS) pen.fillRect(x(t) - 1, 0, 3, height);
  pen.lineWidth = 2;
  for (const [axis, colour] of Object.entries(LINES)) {
    const scale = axis[0] === 'g' ? GYRO_SCALE * 2 : LIN_SCALE * 3;
    pen.strokeStyle = colour;
    pen.beginPath();
    for (const s of waves) pen.lineTo(x(s.t), height / 2 - Math.max(-1, Math.min(1, s[axis] / scale)) * (height / 2 - 6));
    pen.stroke();
  }
  const state = $('#wave-state');
  const set = (text, kind = '') => { state.textContent = text; state.className = `soft small center ${kind}`; };
  if (calib) set('Calibrating');
  else if (teaching) set(teaching.phase === 'go' ? 'Recording' : 'Waiting');
  else if (sequence.count) set(`${sequence.count} tap${sequence.count > 1 ? 's' : ''}`, 'reading');
  else if (reader.reading) set('Reading', 'reading');
  else if (reader.ready) set('Ready', 'ready');
  else set('Moving');
}
requestAnimationFrame(drawWaves);

$('#full-log').checked = rec.fullLog;
$('#full-log').onchange = () => { rec.fullLog = $('#full-log').checked; try { localStorage.setItem('epsilon-full-log', rec.fullLog ? 'on' : 'off'); } catch { /* private window */ } };

$('#reset').onclick = () => {
  if (!confirm('Forget every recorded gesture?')) return;
  taught = parseExamples(null, IDS);
  learned = parseExamples(null, IDS);
  tapWords = {};
  save();
  if (band) teach(IDS);
};

// --- connecting ------------------------------------------------------------------------------------------
function bandState(text, on = false) {
  $('#band-state').textContent = `Band ${BAND} ${text}`;
  $('#band-state').className = `pill${on ? ' on' : ''}`;
}
/** ±8 g instead of ±2 g: a firm tap reads more than 2 g, and at 2 g its peak is cut off. */
async function widen() {
  try { await band.setMotion({ accelRange: 8 }); log('accelerometer: ±8 g'); } catch (e) { log(`accelerometer range not set: ${e.message}`); }
}
function afterSetup() {
  const missing = IDS.filter((id) => !isTaught(id));
  if (missing.length) teach(missing);
  else use();
}
view('connect');

onConnect(async (theBand, pretend) => {
  band = theBand;
  if (HOSTED) BAND = band.number;                     // page.js connected only to the number typed
  band.on('motion', onSample);
  band.on('reconnecting', () => { reader.reset(); sequence.reset(); cancel(false); bandState('reconnecting'); });
  band.on('reconnected', () => { bandState('connected', true); widen(); if (teaching) beginWord(); else light(null); });
  band.on('disconnect', () => {
    band = null;
    reader.reset();
    sequence.reset();
    cancel(false);
    stopTeaching();
    teaching = null;
    stopCalibration();
    clearTimeout(afterCalib);
    bandState('not connected');
    view('connect');
    $('#waves').hidden = true;
  });

  if (pretend) {
    pretend.playMotion([{}]);                        // the pretend hand rests between motions
    const box = $('#pretend-moves');
    box.textContent = '';
    const button = (id, text, fn) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.id = id;
      b.onclick = fn;
      box.append(b, ' ');
    };
    for (const [name, [shape, seconds]] of Object.entries(PRETEND)) {
      button(`pretend-${name}`, name, () => { pretend.playMotion(shape, { seconds }); pretend.playMotion({}, { seconds: 0.6 }); });
    }
    const tapRun = (n, gap) => () => {
      for (let k = 0; k < n; k++) { pretend.playMotion(...PRETEND_TAP); pretend.playMotion({}, { seconds: gap }); }
    };
    button('pretend-taps1', '1 tap', tapRun(1, 0.1));
    button('pretend-taps2', '2 taps', tapRun(2, 0.15));
    button('pretend-taps3', '3 fast taps', tapRun(3, 0.12));
    button('pretend-taps3slow', '3 slow taps', tapRun(3, 0.6));
    button('pretend-taps4', '4 taps', tapRun(4, 0.2));
  }

  // As many samples as the link carries well (416/s), averaged down in the page for movements
  // and read raw for taps. Falls back to 208 and then 50 a second.
  for (const rate of [416, 208, 50]) {
    try {
      await band.configure(rate === 50 ? { motion: 50, events: true } : { motion: rate, sensors: 'both', events: true });
      log(`motion: ${rate}/s`);
      break;
    } catch (e) {
      log(`motion ${rate}/s not possible: ${e.message}`);
    }
  }
  await widen();
  if (!band) return;                                 // dropped while setting up: the disconnect handler has it
  if (band.number !== BAND) {                        // Band.connect(44) already checks; belt and braces
    await band.disconnect();
    throw new Error(`That is band ${band.number}, not ${BAND}. Disconnected.`);
  }
  say('');
  rec.event({ kind: 'connected', name: band.name, info: band.info });
  bandState('connected', true);
  $('#waves').hidden = false;
  if (!tapSettings) startCalibration(afterSetup, REFERENCE_STEPS, 'reference');   // first time: the full reference recording
  else afterSetup();
});
