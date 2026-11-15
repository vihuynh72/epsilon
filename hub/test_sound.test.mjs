// node --test hub/test_sound.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, fingerprint, match, similarity, wordIn } from './web/sound-match.js';

// A made-up sound: quiet, then `frames` loud frames whose energy sits around band `peak`, moving by `slide`.
function sound(peak, slide = 0, frames = 20, level = -40, noise = 0) {
  const quiet = () => Array.from({ length: BANDS }, () => -90 + noise * Math.random());
  const out = [quiet(), quiet(), quiet()];
  for (let i = 0; i < frames; i += 1) {
    const centre = peak + (slide * i) / frames;
    out.push(Array.from({ length: BANDS }, (_, b) => level - 6 * Math.abs(b - centre) + noise * Math.random()));
  }
  return [...out, quiet(), quiet(), quiet()];
}

test('silence and a click are not a sound', () => {
  assert.equal(fingerprint(sound(5, 0, 0)), null);
  assert.equal(fingerprint(sound(5, 0, 2)), null);
  assert.equal(fingerprint([]), null);
});

test('the same sound louder, quieter, longer or shorter is still the same', () => {
  const a = fingerprint(sound(5, 6));
  assert.ok(similarity(a, fingerprint(sound(5, 6, 20, -20))) > 0.99, 'louder');
  assert.ok(similarity(a, fingerprint(sound(5, 6, 36))) > 0.95, 'longer');
  assert.ok(similarity(a, fingerprint(sound(5, 6, 20, -40, 3))) > 0.9, 'a little noise');
});

test('picks the taught meaning, and is not sure when two meanings are close', () => {
  const taught = [
    { meaning: 'water', print: fingerprint(sound(4, 0)) },
    { meaning: 'water', print: fingerprint(sound(4, 1)) },
    { meaning: 'help', print: fingerprint(sound(14, -8)) },
  ];
  const w = match(fingerprint(sound(4, 0.5, 24, -35, 2)), taught);
  assert.equal(w.meaning, 'water');
  assert.ok(w.sure);
  assert.equal(match(fingerprint(sound(14, -8, 16, -45, 2)), taught).meaning, 'help');

  const between = match(fingerprint(sound(9, -3)), taught);
  assert.equal(between.sure, false, 'a sound between the two must not be offered as an answer');
  assert.equal(match(fingerprint(sound(4, 0)), []).sure, false, 'nothing taught, nothing matched');
});

test('a spoken word is picked out only when it is clear which one was said', () => {
  const words = ['water', 'food', 'help'];
  assert.equal(wordIn('Water, please.', words), 'water');
  assert.equal(wordIn('i need help', words), 'help');
  assert.equal(wordIn('waterfall', words), null, 'part of another word does not count');
  assert.equal(wordIn('food and water', words), null, 'two words is not a clear request');
  assert.equal(wordIn('', words), null);
});
