// node --test hub/test/       (from the repo folder; plain Node, no band, no browser)
import test from 'node:test';
import assert from 'node:assert/strict';
import { Segmenter, toShape, classify, check, parseExamples, TapCounter, SHAPE_LENGTH } from '../sources/band/gestures.js';
import { PRETEND } from '../sources/band/pretend-motions.js';

const REST = { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 };
const WORDS = ['water', 'food', 'parents', 'sleep', 'help'];
const MOVES = ['circle', 'shake', 'flick', 'punch', 'raise'];   // word i <- pretend move i

/** What a band sends at 50/s: rest, the motion (stretched by `slow`, with sensor noise), rest. */
function samples(shape, seconds, { slow = 1, noise = 0.02, from = 5000 } = {}) {
  const out = [];
  const jitter = () => (Math.random() - 0.5) * noise;
  for (let i = 0; i < (seconds * slow + 1.2) * 50; i++) {
    const s = (i / 50 - 0.4) / slow;
    const now = { ...REST, ...(s >= 0 && s < seconds ? shape(s) : {}) };
    const sample = { t: from + i * 20 };
    for (const axis of Object.keys(REST)) sample[axis] = now[axis] + jitter() * (axis[0] === 'g' ? 100 : 1);
    out.push(sample);
  }
  return out;
}
function shapeOf(move, options) {
  const segmenter = new Segmenter();
  const cut = samples(...PRETEND[move], options).map((s) => segmenter.feed(s)).filter(Boolean);
  assert.equal(cut.length, 1, `${move} should be one gesture`);
  return toShape(cut[0]);
}
function trained() {
  const examples = {};
  WORDS.forEach((w, i) => {
    examples[w] = [shapeOf(MOVES[i]), shapeOf(MOVES[i], { slow: 1.2 }), shapeOf(MOVES[i], { slow: 0.85 })];
  });
  return examples;
}

test('5 words, 3 examples each: the leave-one-out check finds no mix-ups', () => {
  const report = check(trained());
  for (const w of WORDS) assert.deepEqual(report[w].wrong, [], `${w}: ${JSON.stringify(report[w])}`);
});

test('a new, slightly different try is recognised as the right word', () => {
  const examples = trained();
  WORDS.forEach((w, i) => {
    const got = classify(shapeOf(MOVES[i], { slow: 1.1, noise: 0.04 }), examples);
    assert.equal(got.id, w, `${MOVES[i]} -> ${got.id} (${got.reason ?? ''})`);
  });
});

test('a motion nobody recorded is "not sure", not a wrong word', () => {
  const examples = trained();
  const spin = [(s) => ({ gx: 300 * Math.sin(Math.PI * s / 0.9), gz: -200, ay: 0.7 }), 0.9];
  const segmenter = new Segmenter();
  const cut = samples(...spin).map((s) => segmenter.feed(s)).filter(Boolean);
  const got = classify(toShape(cut[0]), examples);
  assert.equal(got.id, null, `got ${got.id}`);
});

test('two words with the same gesture are "not sure (close)", never a guess', () => {
  const same = { water: [shapeOf('circle'), shapeOf('circle', { slow: 1.2 })], food: [shapeOf('circle', { slow: 0.9 }), shapeOf('circle')] };
  const got = classify(shapeOf('circle', { slow: 1.05 }), same);
  assert.equal(got.id, null);
  assert.equal(got.reason, 'close');
  assert.ok(check(same).water.wrong.length > 0, 'the check flags the pair');
});

test('no examples: nothing is recognised', () => {
  assert.equal(classify(shapeOf('circle'), { water: [] }).reason, 'none');
});

test('stored examples: garbage is dropped, good shapes are kept', () => {
  const good = new Array(SHAPE_LENGTH).fill(0.1);
  const text = JSON.stringify({ water: [good, [1, 2], 'x', good.map(() => null)], food: 'nope' });
  assert.deepEqual(parseExamples(text, ['water', 'food', 'help']), { water: [good], food: [], help: [] });
  assert.deepEqual(parseExamples('{not json', ['water']), { water: [] });
  assert.deepEqual(parseExamples(null, ['water']), { water: [] });
});

test('taps: three in 2 s is Help, slower taps are not', () => {
  const t = new TapCounter();
  assert.equal(t.feed('tap', 0), false);
  assert.equal(t.feed('tap', 400), false);
  assert.equal(t.feed('tap', 800), true);
  assert.equal(t.feed('tap', 900), false, 'counting starts again after Help');

  const slow = new TapCounter();
  assert.equal(slow.feed('tap', 0), false);
  assert.equal(slow.feed('tap', 1500), false);
  assert.equal(slow.feed('tap', 3000), false, 'the first tap is older than 2 s');
});

test('taps: a double-tap counts as two, or one more if its first tap came as a tap', () => {
  const a = new TapCounter();
  assert.equal(a.feed('double-tap', 0), false);
  assert.equal(a.feed('tap', 500), true, 'double-tap + tap = 3');

  const b = new TapCounter();
  assert.equal(b.feed('tap', 0), false);
  assert.equal(b.feed('double-tap', 200), false, 'the band reported tap, then double-tap for the same pair: 2');
  assert.equal(b.feed('tap', 700), true);

  assert.equal(new TapCounter().feed('free-fall', 0), false);
});
