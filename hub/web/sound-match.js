// Match a short sound against a wearer's own taught examples. No audio is stored:
// only the fingerprint below (160 numbers) is kept.
//
// A recording arrives as frames: one array of BANDS loudness values (dB) every ~40 ms.

export const BANDS = 20;       // log-spaced bands, 100 Hz to 6 kHz
export const STEPS = 8;        // the sound is squeezed or stretched to this many time steps
// Guesses, not measured on any real wearer. Tune them from the scores the page shows.
export const ACCEPT = 0.8;     // a match must be at least this similar (1 = identical)
export const MARGIN = 0.05;    // and this much better than the best other meaning
export const MIN_FRAMES = 4;   // fewer loud frames than this (about 160 ms) is not a sound
const LOUDER_BY = 10;          // dB above the recording's own quiet level to count as sound

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** 160 numbers describing the shape of the sound over time, or null when nothing was heard. */
export function fingerprint(frames) {
  if (!frames || frames.length < MIN_FRAMES) return null;
  const level = frames.map(mean);
  const quiet = [...level].sort((a, b) => a - b)[Math.floor(level.length * 0.1)];
  const loud = level.map((v) => v > quiet + LOUDER_BY);
  const first = loud.indexOf(true), last = loud.lastIndexOf(true);
  if (first < 0 || loud.filter(Boolean).length < MIN_FRAMES) return null;
  const sound = frames.slice(first, last + 1);

  const shape = [];
  for (let s = 0; s < STEPS; s += 1) {
    const from = Math.floor((s * sound.length) / STEPS);
    const to = Math.max(from + 1, Math.floor(((s + 1) * sound.length) / STEPS));
    const part = sound.slice(from, to);
    for (let b = 0; b < BANDS; b += 1) shape.push(mean(part.map((f) => f[b])));
  }
  // remove overall loudness and scale, so near and far, soft and loud, give the same fingerprint
  const m = mean(shape);
  const sd = Math.sqrt(mean(shape.map((v) => (v - m) ** 2))) || 1;
  return shape.map((v) => (v - m) / sd);
}

/** How alike two fingerprints are: 1 = the same shape, 0 = unrelated. */
export function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot / a.length;
}

/**
 * Compare with taught examples [{meaning, print}].
 * Returns {meaning, score, runnerUp, sure}. `sure` is false when the match is weak or two meanings are close:
 * then the page must not suggest it as an answer.
 */
export function match(print, examples) {
  const best = {};
  for (const e of examples) {
    if (!e.print || e.print.length !== print.length) continue;
    const s = similarity(print, e.print);
    if (!(e.meaning in best) || s > best[e.meaning]) best[e.meaning] = s;
  }
  const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { meaning: null, score: 0, runnerUp: 0, sure: false };
  const [meaning, score] = ranked[0];
  const runnerUp = ranked.length > 1 ? ranked[1][1] : 0;
  return { meaning, score, runnerUp, sure: score >= ACCEPT && score - runnerUp >= MARGIN };
}
