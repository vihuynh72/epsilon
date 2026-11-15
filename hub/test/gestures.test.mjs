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
import { TapDetector, TapSequencer, calibrate, TAP_DEFAULTS } from '../sources/band/gestures.js';

/** Raw 416/s samples: rest, with a tap (a short ringing spike, a little wobble) at each time in `taps`. */
function tapSamples(taps, { seconds = 3, amp = 1.0, noise = 0.01, move = null } = {}) {
  const out = [];
  for (let i = 0; i < seconds * 416; i++) {
    const t = (i * 1000) / 416;
    const s = { t: 10000 + t, ...REST };
    for (const at of taps) {
      const d = t - at;
      if (d >= 0 && d < 40) { s.az += amp * Math.exp(-d / 6) * Math.cos(2 * Math.PI * d / 10); s.gx += 15 * Math.exp(-d / 10); }
    }
    if (move) Object.assign(s, Object.fromEntries(Object.entries(move(t / 1000)).map(([k, v]) => [k, (s[k] ?? 0) + v])));
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

test('taps: 3 fast taps (150 ms apart) are 3, not 1 or 2', () => {
  assert.deepEqual(countTaps(tapSamples([500, 650, 800])), [3]);
});

test('taps: 3 slow taps (600 ms apart) are still one sequence of 3', () => {
  assert.deepEqual(countTaps(tapSamples([300, 900, 1500])), [3]);
});

test('taps: two groups with a long gap are two sequences', () => {
  assert.deepEqual(countTaps(tapSamples([200, 350, 1800, 1950, 2100], { seconds: 4 })), [2, 3]);
});

test('taps: very fast taps (90 ms apart) are still counted one by one', () => {
  assert.deepEqual(countTaps(tapSamples([500, 590, 680, 770])), [4]);
});

test('taps: a soft tap below the threshold is ignored, rest and noise give none', () => {
  assert.deepEqual(countTaps(tapSamples([500], { amp: 0.1 })), []);
  assert.deepEqual(countTaps(tapSamples([], { noise: 0.04 })), []);
});

test('taps: a smooth arm movement is not a tap', () => {
  const wave = (s) => ({ ax: 0.8 * Math.sin(2 * Math.PI * 1.5 * s), gz: 200 * Math.cos(2 * Math.PI * 1.5 * s) });
  assert.deepEqual(countTaps(tapSamples([], { move: wave })), []);
});

test('calibration: thresholds land between noise and taps; slow gaps set the sequence gap', () => {
  const rec = (list, settings) => { const d = new TapDetector(settings); return list.map((s) => { const tap = d.feed(s); return { impulse: d.impulse, tap }; }); };
  const low = { ...TAP_DEFAULTS, threshold: 0.12, refractoryMs: 50 };
  const still = rec(tapSamples([], { noise: 0.02 }), low);
  const slow = rec(tapSamples([200, 900, 1600, 2300, 3000], { seconds: 3.5, amp: 0.7 }), low);
  const fast = rec(tapSamples([200, 330, 460, 590, 720], { amp: 0.7 }), low);
  const move = rec(tapSamples([], { move: (s) => ({ ax: 0.5 * Math.sin(2 * Math.PI * s) }) }), low);
  const { settings, warnings } = calibrate({ still, slow, fast, move });
  assert.deepEqual(warnings, []);
  assert.ok(settings.threshold > 0.05 && settings.threshold < 0.5, `threshold ${settings.threshold}`);
  assert.ok(settings.maxGapMs >= 900 && settings.maxGapMs <= 1200, `maxGap ${settings.maxGapMs}`);
  assert.ok(settings.refractoryMs <= 70, `refractory ${settings.refractoryMs}`);
  // with those settings, fast and slow soft taps both count right
  assert.deepEqual(countTaps(tapSamples([200, 330, 460], { amp: 0.7 }), settings), [3]);
  assert.deepEqual(countTaps(tapSamples([200, 900, 1600], { seconds: 3.5, amp: 0.7 }), settings), [3]);
});

test('reader: taps do not come out as movement gestures; a real movement still does', () => {
  const reader = new MotionReader();
  const taps = tapSamples([1200, 1350, 1500], { seconds: 3 });
  assert.deepEqual(read(taps, reader), [], 'taps only');
  const found = read(samples(...PRETEND.circle).map((s) => ({ ...s, t: s.t + 20000 })), reader);
  assert.equal(found.length, 1, 'the circle after them');
});
