// node --test hub/test/gestures.test.mjs     (plain Node, no band, no browser)
import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionReader, Smoother, Fusion, toShape, cutWindow, classify, check, clashes, parseExamples, TapCounter, SHAPE_LENGTH } from '../sources/band/gestures.js';
import { PRETEND } from '../sources/band/pretend-motions.js';

const REST = { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 };
const WORDS = ['water', 'food', 'parents', 'sleep', 'help'];
const MOVES = ['circle', 'shake', 'flick', 'punch', 'raise'];   // word i <- pretend move i
const RATE = 208;

/** What the band sends at 208/s: 1 s of rest, the motion (stretched by `slow`, with noise), 1 s of rest. */
function samples(shape, seconds, { slow = 1, noise = 0.02, bias = [0, 0, 0], from = 5000 } = {}) {
  const out = [];
  const jitter = () => (Math.random() - 0.5) * noise;
  for (let i = 0; i < (seconds * slow + 2) * RATE; i++) {
    const s = (i / RATE - 1) / slow;
    const now = { ...REST, ...(s >= 0 && s < seconds ? shape(s) : {}) };
    const sample = { t: from + (i * 1000) / RATE };
    for (const axis of Object.keys(REST)) sample[axis] = now[axis] + jitter() * (axis[0] === 'g' ? 100 : 1);
    sample.gx += bias[0]; sample.gy += bias[1]; sample.gz += bias[2];
    out.push(sample);
  }
  return out;
}
/** Through the whole reader, as in use. */
function read(list, reader = new MotionReader()) {
  return list.map((s) => reader.feed(s)).filter(Boolean);
}
/** As in teaching: every fused step of the window, then cutWindow. */
function teachShape(move, options) {
  const reader = new MotionReader();
  const steps = [];
  for (const s of samples(...PRETEND[move], options)) { reader.feed(s); if (reader.step && steps.at(-1) !== reader.step) steps.push(reader.step); }
  return toShape(cutWindow(steps));
}
function useShape(move, options) {
  const found = read(samples(...PRETEND[move], options));
  assert.equal(found.length, 1, `${move}: ${found.length} gestures cut`);
  return toShape(found[0]);
}
function trained() {
  return Object.fromEntries(WORDS.map((w, i) => [w, [teachShape(MOVES[i]), teachShape(MOVES[i], { slow: 1.2 }), teachShape(MOVES[i], { slow: 0.85 })]]));
}

test('smoother: 208/s becomes one averaged sample per 20 ms', () => {
  const sm = new Smoother();
  const out = samples(() => ({}), 0).map((s) => sm.feed(s)).filter(Boolean);
  assert.ok(Math.abs(out.length - 100) <= 2, `${out.length} steps for 2 s`);
  assert.ok(out.every((s) => Math.abs(s.az - 1) < 0.02), 'noise averaged out');
});

test('fusion: a real turn (gravity moving through the band) leaves almost no "movement"', () => {
  // The band turns about x at 90 deg/s for 1 s: gravity, seen from the band, turns the other way.
  const f = new Fusion();
  let worst = 0;
  for (let i = 0; i <= 150; i++) {
    const t = i * 20, angle = Math.min(Math.max(t - 1000, 0), 1000) / 1000 * (Math.PI / 2);
    const turning = t > 1000 && t <= 2000 ? 90 : 0;
    const out = f.feed({ t, ax: 0, ay: Math.sin(angle), az: Math.cos(angle), gx: turning, gy: 0, gz: 0 });
    if (i > 5) worst = Math.max(worst, Math.hypot(out.lx, out.ly, out.lz));
  }
  assert.ok(worst < 0.1, `largest false movement ${worst.toFixed(3)} g`);
});

test('fusion: a gyro bias is learned while the band lies still', () => {
  const f = new Fusion();
  let last;
  for (let i = 0; i < 150; i++) last = f.feed({ t: i * 20, ...REST, gx: 4, gy: -3, gz: 2 });
  assert.ok(Math.hypot(last.gx, last.gy, last.gz) < 0.5, `left over ${Math.hypot(last.gx, last.gy, last.gz).toFixed(2)} deg/s`);
});

test('every pretend motion is cut as exactly one gesture, also with a gyro bias', () => {
  for (const move of MOVES) {
    assert.equal(read(samples(...PRETEND[move])).length, 1, move);
    assert.equal(read(samples(...PRETEND[move], { bias: [5, -4, 3] })).length, 1, `${move} with bias`);
  }
  assert.equal(read(samples(() => ({}), 1)).length, 0, 'rest is no gesture');
});

test('moving all the time (no pause before) never starts a gesture', () => {
  const wobble = [(s) => ({ gx: 120 * Math.sin(2 * Math.PI * 3 * s), ax: 0.3 * Math.sin(2 * Math.PI * 3 * s) }), 6];
  const reader = new MotionReader();
  // the hand is already moving when the stream starts: no rest before it
  const list = samples(...wobble).filter((s) => s.t >= 5000 + 1000);
  assert.equal(read(list, reader).length, 0);
});

test('5 words taught 3 times each: no mix-ups, and new tries are recognised', () => {
  const examples = trained();
  const report = check(examples);
  for (const w of WORDS) assert.deepEqual(report[w].wrong, [], `${w}: ${JSON.stringify(report[w])}`);
  WORDS.forEach((w, i) => {
    const got = classify(useShape(MOVES[i], { slow: 1.1, noise: 0.04 }), examples);
    assert.equal(got.id, w, `${MOVES[i]} -> ${got.id} (${got.reason ?? ''})`);
  });
});

test('a motion nobody taught is "not sure", not a wrong word', () => {
  const examples = trained();
  const spin = [(s) => ({ gx: 300 * Math.sin(Math.PI * s / 0.9), gz: -200, ay: 0.7 }), 0.9];
  const found = read(samples(...spin));
  assert.equal(found.length, 1);
  assert.equal(classify(toShape(found[0]), examples).id, null);
});

test('two words taught with the same movement clash, and the page is told', () => {
  const examples = { water: [teachShape('circle'), teachShape('circle', { slow: 1.2 }), teachShape('circle', { slow: 0.9 })], food: [teachShape('circle', { slow: 1.1 }), teachShape('circle'), teachShape('circle', { slow: 0.95 })] };
  assert.ok(clashes('food', examples).includes('water'));
  // (teaching refuses such a word, so the matcher never has to choose between them)
});

test('teaching: a window with no movement gives nothing', () => {
  const reader = new MotionReader();
  const steps = [];
  for (const s of samples(() => ({}), 0)) { reader.feed(s); if (reader.step && steps.at(-1) !== reader.step) steps.push(reader.step); }
  assert.equal(cutWindow(steps), null);
});

test('stored examples: garbage is dropped, good shapes are kept', () => {
  const good = new Array(SHAPE_LENGTH).fill(0.1);
  const text = JSON.stringify({ water: [good, [1, 2], 'x', good.map(() => null)], food: 'nope' });
  assert.deepEqual(parseExamples(text, ['water', 'food', 'help']), { water: [good], food: [], help: [] });
  assert.deepEqual(parseExamples('{not json', ['water']), { water: [] });
});

test('taps: three in 2 s is Help; a double-tap counts as two', () => {
  const t = new TapCounter();
  assert.equal(t.feed('tap', 0), false);
  assert.equal(t.feed('tap', 400), false);
  assert.equal(t.feed('tap', 800), true);
  const slow = new TapCounter();
  slow.feed('tap', 0); slow.feed('tap', 1500);
  assert.equal(slow.feed('tap', 3000), false);
  const d = new TapCounter();
  assert.equal(d.feed('double-tap', 0), false);
  assert.equal(d.feed('tap', 500), true);
});

// --- taps ---------------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { TapDetector, TapSequencer, calibrate, TAP_DEFAULTS } from '../sources/band/gestures.js';
import * as imports from '../sources/band/gestures.js';

/**
 * Raw 416/s samples with taps shaped like band 44's real ones: the hit (a ~15 ms ringing spike),
 * a rebound 120 ms later at 60 %, a small spike at 190 ms, and the wrist jolting at ~800 deg/s.
 */
function tapSamples(taps, { seconds = 3, amp = 2.4, noise = 0.01, move = null } = {}) {
  const out = [];
  // ~15 ms wide at half height, like band 44's real hits (13-26 ms)
  const ring = (d, a) => (d >= 0 && d < 60 ? a * Math.exp(-d / 10) * Math.cos(2 * Math.PI * d / 28) : 0);
  for (let i = 0; i < seconds * 416; i++) {
    const t = (i * 1000) / 416;
    const s = { t: 10000 + t, ...REST };
    for (const at of taps) {
      const d = t - at;
      s.az += ring(d, amp) + ring(d - 120, amp * 0.6) + ring(d - 190, amp * 0.1);
      if (d >= 0 && d < 200) s.gx += 800 * Math.exp(-d / 40) * Math.sin(2 * Math.PI * d / 80);
    }
    if (move) for (const [k, v] of Object.entries(move(t / 1000))) s[k] += v;
    for (const k of ['ax', 'ay', 'az']) s[k] += (Math.random() - 0.5) * noise;
    out.push(s);
  }
  return out;
}
function countTaps(list, settings) {
  const d = new TapDetector(settings), q = new TapSequencer(settings), seqs = [];
  for (const s of list) { const tap = d.feed(s); if (tap) q.add(tap); const done = q.tick(s.t); if (done) seqs.push(done.count); }
  const last = q.tick(Infinity); if (last) seqs.push(last.count);
  return seqs;
}

test('taps: one real-shaped tap (hit, rebound, after-spike) is one tap', () => {
  assert.deepEqual(countTaps(tapSamples([500])), [1]);
});

test('taps: 1 to 5 taps are counted exactly, fast (250 ms) and slow (850 ms)', () => {
  for (let n = 1; n <= 5; n++) {
    assert.deepEqual(countTaps(tapSamples(Array.from({ length: n }, (_, k) => 300 + k * 250))), [n], `${n} fast`);
    assert.deepEqual(countTaps(tapSamples(Array.from({ length: n }, (_, k) => 300 + k * 850), { seconds: 6 })), [n], `${n} slow`);
  }
});

test('taps: two groups with a long gap are two sequences', () => {
  assert.deepEqual(countTaps(tapSamples([200, 450, 2400, 2650, 2900], { seconds: 5 })), [2, 3]);
});

test('taps: a soft brush, noise or rest gives none', () => {
  assert.deepEqual(countTaps(tapSamples([500], { amp: 0.2 })), []);
  assert.deepEqual(countTaps(tapSamples([], { noise: 0.06 })), []);
});

test('taps: a smooth or brisk arm movement is not a tap', () => {
  const wave = (s) => ({ ax: 0.8 * Math.sin(2 * Math.PI * 1.5 * s), gz: 200 * Math.cos(2 * Math.PI * 1.5 * s) });
  assert.deepEqual(countTaps(tapSamples([], { move: wave })), []);
  const shake = (s) => ({ ax: 1.5 * Math.sin(2 * Math.PI * 4 * s), gz: 400 * Math.cos(2 * Math.PI * 4 * s) });
  assert.deepEqual(countTaps(tapSamples([], { move: shake })), []);
});

test('band 44, real calibration recording: 5 slow and 5 fast taps, none at rest or moving', () => {
  const rec = JSON.parse(readFileSync(new URL('./fixtures/taps-band44.json', import.meta.url), 'utf8'));
  const { settings, warnings } = calibrate(rec.steps);
  assert.deepEqual(warnings, []);
  const samplesOf = (rows) => rows.map((r) => ({ t: r[0], ax: r[1], ay: r[2], az: r[3], gx: r[4], gy: r[5], gz: r[6] }));
  assert.deepEqual(countTaps(samplesOf(rec.steps.slow), settings), [5], 'slow');
  assert.deepEqual(countTaps(samplesOf(rec.steps.fast), settings), [5], 'fast');
  assert.deepEqual(countTaps(samplesOf(rec.steps.still), settings), [], 'still');
  assert.deepEqual(countTaps(samplesOf(rec.steps.move), settings), [], 'moving');
});

test('calibration from real-shaped taps: sensible numbers, then soft and hard taps both count', () => {
  const rows = (list) => list.map((s) => [s.t, s.ax, s.ay, s.az, s.gx, s.gy, s.gz]);
  const { settings, warnings } = calibrate({
    still: rows(tapSamples([], { noise: 0.02 })),
    slow: rows(tapSamples([200, 1050, 1900, 2750, 3600], { seconds: 4 })),
    fast: rows(tapSamples([200, 450, 700, 950, 1200])),
    move: rows(tapSamples([], { move: (s) => ({ ax: 0.5 * Math.sin(2 * Math.PI * s) }) })),
    more: [rows(tapSamples([200, 1000, 1800, 2600, 3400], { seconds: 4, amp: 1.2 }))],     // soft taps
  });
  assert.deepEqual(warnings, []);
  assert.ok(settings.threshold < 0.6, `threshold ${settings.threshold} lets soft taps through`);
  assert.ok(settings.maxGapMs >= 1000 && settings.maxGapMs <= 1300, `maxGap ${settings.maxGapMs}`);
  assert.ok(settings.ringMs >= 150 && settings.ringMs < 250, `ring ${settings.ringMs}`);
  assert.deepEqual(countTaps(tapSamples([200, 450, 700], { amp: 1.2 }), settings), [3], 'soft');
  assert.deepEqual(countTaps(tapSamples([200, 450, 700], { amp: 4 }), settings), [3], 'hard');
});

test('reader: taps do not come out as movement gestures; a real movement still does', () => {
  const reader = new MotionReader();
  assert.deepEqual(read(tapSamples([1200, 1450, 1700], { seconds: 3 }), reader), [], 'taps only');
  const found = read(samples(...PRETEND.circle).map((s) => ({ ...s, t: s.t + 20000 })), reader);
  assert.equal(found.length, 1, 'the circle after them');
});

test('teaching: a window of taps counts as taps, a window with a movement does not', () => {
  const { tapsOnly } = imports;
  const windowOf = (list, settings) => {
    const reader = new MotionReader(settings), steps = [], taps = [];
    for (const s of list) { reader.feed(s); if (reader.tap) taps.push(reader.tap.t); if (reader.step && steps.at(-1) !== reader.step) steps.push(reader.step); }
    return { steps, taps };
  };
  for (const n of [1, 2, 3, 5]) {
    const w = windowOf(tapSamples(Array.from({ length: n }, (_, k) => 500 + k * 300)));
    assert.equal(w.taps.length, n, `${n} taps felt`);
    assert.ok(tapsOnly(w.steps, w.taps, TAP_DEFAULTS.ringMs, 300), `${n} taps are taps`);
  }
  const rec = JSON.parse(readFileSync(new URL('./fixtures/taps-band44.json', import.meta.url), 'utf8'));
  const { settings } = calibrate(rec.steps);
  const real = windowOf(rec.steps.slow.map((r) => ({ t: r[0], ax: r[1], ay: r[2], az: r[3], gx: r[4], gy: r[5], gz: r[6] })), settings);
  assert.equal(real.taps.length, 5);
  assert.ok(tapsOnly(real.steps, real.taps, settings.ringMs, 300), 'the real slow taps are taps');
  const circle = windowOf(samples(...PRETEND.circle));
  assert.ok(!tapsOnly(circle.steps, [circle.steps[60].t], TAP_DEFAULTS.ringMs, 300), 'a circle with a tap in it is a movement');
});

// --- movements relative to the wearer ---------------------------------------------------------
// Physically correct samples: the hand moves in the world (x forward, y left, z up) while the
// band is worn at some orientation. The sensor reads the push plus 1 g against gravity, in its
// own axes. The forearm is the band's x axis.
const rotX = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const rotY = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const tr = (A) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[j][i]));
const app = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const DIRS = { forward: [1, 0, 0], back: [-1, 0, 0], left: [0, 1, 0], right: [0, -1, 0], up: [0, 0, 1], down: [0, 0, -1] };
/** `dir` moved 0.6 s (speed up, slow down), band turned `roll` about the forearm, forearm tilted `tilt`. */
function worldMove(dir, { roll = 0, tilt = 0, slow = 1, noise = 0.01 } = {}) {
  const R = mul(rotY(-tilt), rotX(roll));               // band -> world
  const toBand = tr(R);
  const out = [], T = 0.6 * slow;
  for (let i = 0; i < (T + 2) * 208; i++) {
    const s = i / 208 - 1;
    const push = s >= 0 && s < T ? 1.0 * Math.sin((2 * Math.PI * s) / T) / (slow * slow) : 0;
    const a = app(toBand, [DIRS[dir][0] * push, DIRS[dir][1] * push, DIRS[dir][2] * push + 1]);
    const j = () => (Math.random() - 0.5) * noise;
    out.push({ t: 5000 + (i * 1000) / 208, ax: a[0] + j(), ay: a[1] + j(), az: a[2] + j(), gx: j() * 100, gy: j() * 100, gz: j() * 100 });
  }
  return out;
}
const moveShape = (dir, o) => { const g = read(worldMove(dir, o)); assert.equal(g.length, 1, `${dir} ${JSON.stringify(o ?? {})}: ${g.length} cut`); return toShape(g[0]); };

test('relative: a direction looks the same however the wrist is turned or the forearm tilted', () => {
  const { distance } = imports;
  for (const dir of Object.keys(DIRS)) {
    const base = moveShape(dir);
    for (const o of [{ roll: Math.PI / 2 }, { roll: Math.PI }, { roll: -Math.PI / 3, tilt: 0.5 }]) {
      const d = distance(base, moveShape(dir, o));
      assert.ok(d < 0.3, `${dir} at ${JSON.stringify(o)}: ${d.toFixed(2)} from the same move unturned`);
    }
  }
});

test('relative: the six directions are far apart from each other', () => {
  const { distance } = imports;
  const shapes = Object.fromEntries(Object.keys(DIRS).map((d) => [d, moveShape(d)]));
  // the same move with the wrist turned stays under 0.3 (test above); different directions are
  // at least 5 times further apart than that
  const rows = [];
  for (const a of Object.keys(DIRS)) {
    rows.push(`${a.padEnd(8)}${Object.keys(DIRS).map((b) => distance(shapes[a], shapes[b]).toFixed(2).padStart(6)).join('')}`);
    for (const b of Object.keys(DIRS)) if (a !== b) assert.ok(distance(shapes[a], shapes[b]) > 1.5, `${a} vs ${b}: ${distance(shapes[a], shapes[b]).toFixed(2)}`);
  }
  if (process.env.SHOW) console.log(`        ${Object.keys(DIRS).map((d) => d.padStart(6)).join('')}\n${rows.join('\n')}`);
});

test('relative: taught with the wrist one way, recognised with it turned another way', () => {
  const words = Object.keys(DIRS);
  const examples = Object.fromEntries(words.map((d) => [d, [moveShape(d), moveShape(d, { slow: 1.2 }), moveShape(d, { slow: 0.85 })]]));
  assert.deepEqual(Object.values(check(examples)).flatMap((r) => r.wrong), []);
  for (const d of words) {
    const got = classify(moveShape(d, { roll: Math.PI / 2, tilt: 0.3, slow: 1.1 }), examples);
    assert.equal(got.id, d, `${d} with the wrist turned -> ${got.id ?? got.reason}`);
  }
});

test('confidence: clear matches pass the guardian app (>= 0.8), doubtful ones do not', () => {
  const { confidenceOf } = imports;
  const words = Object.keys(DIRS);
  const examples = Object.fromEntries(words.map((d) => [d, [moveShape(d), moveShape(d, { slow: 1.2 }), moveShape(d, { slow: 0.85 })]]));
  for (const d of words) {
    const got = classify(moveShape(d, { roll: 1, slow: 1.1 }), examples);
    assert.ok(confidenceOf(got) >= 0.8, `${d}: ${confidenceOf(got).toFixed(2)} (score ${got.best.score.toFixed(2)})`);
  }
  assert.ok(confidenceOf({ id: 'x', best: { score: 0.95 }, next: { score: 3 } }) < 0.8, 'at the edge of the limit');
  assert.ok(confidenceOf({ id: 'x', best: { score: 0.3 }, next: { score: 0.4 } }) < 0.8, 'runner-up close behind');
  assert.equal(confidenceOf({ id: null }), 0);
});

test('size: a bump or fidget (a few degrees) is never a gesture; deliberate movements are', () => {
  const { bigEnough } = imports;
  const bump = [(s) => ({ gx: 30 * Math.sin(Math.PI * s / 0.3), ax: 0.1 * Math.sin(2 * Math.PI * s / 0.3) }), 0.3];   // ~5 degrees
  assert.equal(read(samples(...bump)).length, 0, 'a bump is ignored');
  for (const d of Object.keys(DIRS)) assert.equal(read(worldMove(d)).length, 1, `${d} still counts`);
  for (const m of MOVES) assert.ok(bigEnough(read(samples(...PRETEND[m]))[0]).ok, `${m} is big enough`);
});
