// Gesture recognition for Epsilon. No page and no band in here (tests: hub/test/gestures.test.mjs).
//
//   raw motion (any rate, 208/s on the band)
//     -> Smoother    averages into 20 ms steps: filters the fast jitter before it can alias
//     -> Fusion      gyro bias learned while the arm is still; gravity tracked from gyro +
//                    accelerometer, giving the arm's pose and the movement without gravity
//     -> Segmenter   start/stop with two thresholds, a short lead-in, and a pause required
//                    before a gesture (continuous movement, such as stimming, never starts one)
//     -> toShape     32 points x 9 numbers: movement, pose, turning
//     -> classify    DTW distance to every example; each word has its own limit learned from
//                    how alike its own examples are; "not sure" when far or when two words tie
//   MotionReader wires the first four together. TapCounter: 3 taps = Help.

const AXES = ['ax', 'ay', 'az', 'gx', 'gy', 'gz'];

// --- the numbers to tune (guesses until measured on a real wrist) ---------------------
export const STEP_MS = 20;            // Smoother output: one sample per 20 ms (50/s)
export const GYRO_SCALE = 250;        // degrees/second that count as much as...
export const LIN_SCALE = 0.5;         // ...this many g of movement, and as...
export const POSE_WEIGHT = 0.6;       // ...this share of the arm's pose (a unit vector)
export const START_GYRO = 40;         // deg/s: a gesture starts above this...
export const START_LIN = 0.12;        // ...or above this much movement (g)
export const KEEP_GYRO = 15;          // deg/s: still moving above this...
export const KEEP_LIN = 0.05;         // ...or this (g). Below both = still
export const STILL_BEFORE_MS = 400;   // the arm must be still this long before a gesture
export const LEAD_IN_MS = 120;        // kept from before the start, so the start is not cut off
export const QUIET_MS = 300;          // still this long = the gesture is over
export const MIN_MS = 250;            // shorter is a bump
export const MAX_MS = 3000;           // longer is just moving around
export const POINTS = 32;
export const FEATURES = 9;
export const SHAPE_LENGTH = POINTS * FEATURES;
export const WARP = 5;                // DTW may shift a point by this many places (about 15%)
export const SPREAD_FACTOR = 2.5;     // a word's limit = this x how far apart its own examples are
export const MIN_LIMIT = 0.3;
export const MAX_LIMIT = 1.6;
export const ONE_EXAMPLE_LIMIT = 0.8; // limit for a word with a single example
export const MARGIN = 1.3;            // the runner-up must score this many times worse
export const SAME_GESTURE = 1.6;      // while teaching: further than this from the others = a different gesture
export const MAX_EXAMPLES = 8;        // per word: taught + learned

// --- small vector helpers ---------------------------------------------------------------
const unit = (v) => { const n = Math.hypot(...v); return n > 1e-9 ? v.map((x) => x / n) : [0, 0, 1]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Averages raw samples into STEP_MS steps. Returns the finished step, or null. */
export class Smoother {
  constructor(ms = STEP_MS) { this.ms = ms; this.reset(); }
  reset() { this.key = null; this.sum = null; this.n = 0; this.last = -Infinity; }
  feed(s) {
    if (!Number.isFinite(s.t)) return null;
    if (s.t < this.last) this.reset();                 // time went backwards: a new connection
    this.last = s.t;
    const key = Math.floor(s.t / this.ms);
    let out = null;
    if (this.key !== null && key !== this.key) {
      out = { t: (this.key + 1) * this.ms };
      for (const a of AXES) out[a] = this.sum[a] / this.n;
    }
    if (key !== this.key) { this.key = key; this.sum = Object.fromEntries(AXES.map((a) => [a, 0])); this.n = 0; }
    for (const a of AXES) this.sum[a] += Number.isFinite(s[a]) ? s[a] : 0;
    this.n++;
    return out;
  }
}

/**
 * Gyro + accelerometer. While the arm is still it learns the gyro's bias and the
 * accelerometer's reading at rest. It tracks gravity by turning it with the gyro and
 * nudging it toward the accelerometer, so in a fast move gravity stays right.
 * Returns { t, lx ly lz (movement, g), ux uy uz (gravity direction), gx gy gz (deg/s) }.
 */
export class Fusion {
  static ALPHA = 0.04;                 // how hard gravity is pulled toward the accelerometer each step
  static WINDOW = 25;                  // 0.5 s of steps to decide "still"
  constructor() { this.reset(); }
  reset() { this.g = null; this.bias = [0, 0, 0]; this.rest = 1; this.window = []; this.lastT = null; }
  feed(s) {
    const a = [s.ax, s.ay, s.az];
    const raw = [s.gx, s.gy, s.gz];
    const mag = Math.hypot(...a);
    this.window.push({ raw, mag });
    if (this.window.length > Fusion.WINDOW) this.window.shift();
    if (this.window.length === Fusion.WINDOW) this.learnRest();

    const w = raw.map((x, i) => x - this.bias[i]);
    if (!this.g || this.lastT === null || s.t - this.lastT > 200) {
      this.g = unit(a);
    } else {
      // A direction fixed in the world, seen from the turning band: dv/dt = -w x v.
      const dt = (s.t - this.lastT) / 1000;
      const turn = cross(w.map((x) => (x * Math.PI / 180) * dt), this.g);
      let g = this.g.map((x, i) => x - turn[i]);
      if (Math.abs(mag - this.rest) < 0.15) {          // the accelerometer is mostly gravity right now
        const u = unit(a);
        g = g.map((x, i) => x * (1 - Fusion.ALPHA) + u[i] * Fusion.ALPHA);
      }
      this.g = unit(g);
    }
    this.lastT = s.t;
    const [ux, uy, uz] = this.g;
    return { t: s.t, lx: a[0] - ux * this.rest, ly: a[1] - uy * this.rest, lz: a[2] - uz * this.rest, ux, uy, uz, gx: w[0], gy: w[1], gz: w[2] };
  }
  learnRest() {
    const mags = this.window.map((x) => x.mag);
    if (Math.max(...mags) - Math.min(...mags) > 0.03) return;
    const mean = [0, 1, 2].map((i) => this.window.reduce((sum, x) => sum + x.raw[i], 0) / this.window.length);
    if (Math.hypot(...mean) > 15) return;                                   // a slow turn, not bias
    if (this.window.some((x) => x.raw.some((v, i) => Math.abs(v - mean[i]) > 4))) return;
    this.bias = this.bias.map((b, i) => b * 0.9 + mean[i] * 0.1);
    this.rest = this.rest * 0.9 + (mags.reduce((p, q) => p + q, 0) / mags.length) * 0.1;
  }
}

/** Cuts gestures out of fused samples. feed() returns the samples of a finished gesture, or null. */
export class Segmenter {
  constructor() { this.reset(); }
  reset() { this.recent = []; this.samples = null; this.lastMove = 0; this.stillSince = null; this.busySince = null; this.before = null; }
  feed(f) {
    if (this.before && (f.t <= this.before.t || f.t - this.before.t > QUIET_MS)) this.reset();   // a gap: start clean
    this.before = f;
    const turning = Math.hypot(f.gx, f.gy, f.gz), moving = Math.hypot(f.lx, f.ly, f.lz);
    const busy = turning > KEEP_GYRO || moving > KEEP_LIN;
    const start = turning > START_GYRO || moving > START_LIN;

    if (!this.samples) {
      this.recent.push(f);
      while (this.recent.length && f.t - this.recent[0].t > LEAD_IN_MS) this.recent.shift();
      if (!busy) {
        if (this.stillSince === null) this.stillSince = f.t;
        this.busySince = null;
        return null;
      }
      if (this.busySince === null) this.busySince = f.t;
      const wasStill = this.stillSince !== null && this.busySince - this.stillSince >= STILL_BEFORE_MS;
      if (!start) {
        if (f.t - this.busySince > LEAD_IN_MS * 2) this.stillSince = null;   // drifting, not still any more
        return null;
      }
      if (!wasStill) { this.stillSince = null; return null; }               // moving all along: no gesture
      this.samples = [...this.recent];
      this.recent = [];
      this.lastMove = f.t;
      return null;
    }

    this.samples.push(f);
    if (busy) this.lastMove = f.t;
    if (f.t - this.samples[0].t > MAX_MS + QUIET_MS + LEAD_IN_MS) {         // too long: just moving around
      this.samples = null;
      this.stillSince = null;
      return null;
    }
    if (f.t - this.lastMove < QUIET_MS) return null;
    const gesture = this.samples.filter((s) => s.t <= this.lastMove + STEP_MS);
    this.samples = null;
    this.stillSince = this.lastMove;                                        // still since the gesture ended
    this.busySince = null;
    const ms = gesture.at(-1).t - gesture[0].t;
    return ms >= MIN_MS && ms <= MAX_MS + LEAD_IN_MS ? gesture : null;
  }
}

/** Raw band samples in, finished gestures out. */
export class MotionReader {
  constructor() { this.smoother = new Smoother(); this.fusion = new Fusion(); this.segmenter = new Segmenter(); }
  reset() { this.smoother.reset(); this.segmenter.reset(); this.fusion.lastT = null; }   // keeps the learned bias
  feed(raw) {
    const step = this.smoother.feed(raw);
    return step ? this.segmenter.feed(this.fusion.feed(step)) : null;
  }
}

/** A gesture as POINTS x FEATURES numbers, spread evenly over its time. */
export function toShape(gesture) {
  const vec = (f) => [f.lx / LIN_SCALE, f.ly / LIN_SCALE, f.lz / LIN_SCALE,
    f.ux * POSE_WEIGHT, f.uy * POSE_WEIGHT, f.uz * POSE_WEIGHT,
    f.gx / GYRO_SCALE, f.gy / GYRO_SCALE, f.gz / GYRO_SCALE];
  const start = gesture[0].t, length = gesture.at(-1).t - start;
  const shape = [];
  let i = 0;
  for (let p = 0; p < POINTS; p++) {
    const t = start + (length * p) / (POINTS - 1);
    while (i < gesture.length - 2 && gesture[i + 1].t < t) i++;
    const a = gesture[i], b = gesture[i + 1] ?? a;
    const part = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    const va = vec(a), vb = vec(b);
    for (let k = 0; k < FEATURES; k++) shape.push(va[k] + (vb[k] - va[k]) * part);
  }
  return shape;
}

/** DTW distance between two shapes: the mean point distance along the best time alignment. */
export function distance(one, other) {
  const n = POINTS, size = n + 1;
  const D = new Float64Array(size * size).fill(Infinity);
  D[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(1, i - WARP); j <= Math.min(n, i + WARP); j++) {
      let sq = 0;
      for (let k = 0; k < FEATURES; k++) sq += (one[(i - 1) * FEATURES + k] - other[(j - 1) * FEATURES + k]) ** 2;
      D[i * size + j] = Math.sqrt(sq) + Math.min(D[(i - 1) * size + j], D[i * size + j - 1], D[(i - 1) * size + j - 1]);
    }
  }
  return D[n * size + n] / n;
}

/** Each word's limit, from how far apart its own examples are. `tolerance` 1 = normal, higher accepts more. */
export function limits(examples, tolerance = 1) {
  const out = {};
  for (const [id, list] of Object.entries(examples)) {
    if (list.length < 2) { out[id] = ONE_EXAMPLE_LIMIT * tolerance; continue; }
    const nearest = list.map((s, i) => Math.min(...list.filter((_, j) => j !== i).map((o) => distance(s, o))));
    const spread = nearest.reduce((p, q) => p + q, 0) / nearest.length;
    out[id] = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, spread * SPREAD_FACTOR)) * tolerance;
  }
  return out;
}

/** Every word with examples, best first: [{ id, distance, score }], score = distance / that word's limit. */
export function rank(shape, examples, wordLimits = limits(examples)) {
  const out = [];
  for (const [id, list] of Object.entries(examples)) {
    if (!list.length) continue;
    const d = Math.min(...list.map((one) => distance(shape, one)));
    out.push({ id, distance: d, score: d / wordLimits[id] });
  }
  return out.sort((a, b) => a.score - b.score);
}

/** The word, or id null with reason 'none' (no examples), 'far' (nothing near) or 'close' (two words tie). */
export function classify(shape, examples, { tolerance = 1, wordLimits = limits(examples, tolerance), margin = MARGIN } = {}) {
  const ranked = rank(shape, examples, wordLimits);
  const [best, next] = ranked;
  if (!best) return { id: null, reason: 'none', ranked };
  if (best.score > 1) return { id: null, reason: 'far', best, next, ranked };
  if (next && next.score < best.score * margin) return { id: null, reason: 'close', best, next, ranked };
  return { id: best.id, best, next, ranked };
}

/** Leave-one-out: every example against all the others. { id: { right, total, wrong: [...] } } */
export function check(examples, { tolerance = 1 } = {}) {
  const report = {};
  for (const [id, list] of Object.entries(examples)) {
    const result = { right: 0, total: list.length, wrong: [] };
    list.forEach((shape, i) => {
      const rest = { ...examples, [id]: list.filter((_, j) => j !== i) };
      const got = classify(shape, rest, { tolerance });
      if (got.id === id) result.right++;
      else result.wrong.push(got.id ?? got.reason);
    });
    report[id] = result;
  }
  return report;
}

/** While teaching: is this new example the same gesture as the word's earlier ones? */
export function sameGesture(shape, list) {
  if (!list.length) return { ok: true, distance: 0 };
  const d = Math.min(...list.map((one) => distance(shape, one)));
  return { ok: d <= SAME_GESTURE, distance: d };
}

/** After teaching `id`: the other words it gets mixed up with (either way round). */
export function clashes(id, examples, options) {
  const report = check(examples, options);
  const found = new Set();
  for (const w of report[id]?.wrong ?? []) if (w in examples) found.add(w);
  for (const [other, r] of Object.entries(report)) if (other !== id && r.wrong.includes(id)) found.add(other);
  return [...found];
}

/** Examples read back from storage; anything that is not a list of shapes is dropped. */
export function parseExamples(text, ids) {
  let data = null;
  try { data = JSON.parse(text); } catch { /* nothing stored, or garbage */ }
  const out = {};
  for (const id of ids) {
    const list = Array.isArray(data?.[id]) ? data[id] : [];
    out[id] = list.filter((s) => Array.isArray(s) && s.length === SHAPE_LENGTH && s.every(Number.isFinite)).slice(0, MAX_EXAMPLES);
  }
  return out;
}

/**
 * Counts taps. A double-tap counts as two, unless its first tap already came as a 'tap'
 * just before (then one more). feed() is true when `needed` taps fell within `windowMs`.
 */
export class TapCounter {
  constructor({ needed = 3, windowMs = 2000, pairMs = 600 } = {}) {
    Object.assign(this, { needed, windowMs, pairMs });
    this.times = [];
  }
  reset() { this.times = []; }
  feed(kind, now = Date.now()) {
    this.times = this.times.filter((t) => now - t <= this.windowMs);
    if (kind === 'tap') this.times.push(now);
    else if (kind === 'double-tap') {
      const last = this.times.at(-1);
      if (last !== undefined && now - last < this.pairMs) this.times.push(now);
      else this.times.push(now, now);
    } else return false;
    if (this.times.length < this.needed) return false;
    this.times = [];
    return true;
  }
}
