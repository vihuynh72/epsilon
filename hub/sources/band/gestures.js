// Gesture recognition for Epsilon. No page and no band in here (tests: hub/test/gestures.test.mjs).
//
//   raw motion (any rate, 208/s on the band)
//     -> Smoother    averages into 20 ms steps: filters the fast jitter before it can alias
//     -> Fusion      gyro bias learned while the arm is still; gravity tracked from gyro +
//                    accelerometer, giving the arm's pose and the movement without gravity
//     -> Segmenter   start/stop with two thresholds, a short lead-in, and a pause required
//                    before a gesture (continuous movement, such as stimming, never starts one)
//     -> toShape     32 points x 9 numbers, relative to the wearer at the start of the
//                    movement: speed and direction, how far the wrist turned, the push
//     -> classify    DTW distance to every example; each word has its own limit learned from
//                    how alike its own examples are; "not sure" when far or when two words tie
//   TapDetector   finds each tap in the raw signal (before smoothing): a narrow spike out of
//                 calm, with its rebounds counted as one tap. TapSequencer groups taps until a real
//                 gap, so 3 taps are 3 whether fast or slow. Both use the wearer's calibration.
//   MotionReader wires it all together. A cut "gesture" that is only taps goes to the taps,
//   not to the movement matcher, so taps and arm movements never get mixed up.

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
export const STILL_BEFORE_MS = 300;   // the arm must be still this long before a gesture
export const LEAD_IN_MS = 120;        // kept from before the start, so the start is not cut off
export const QUIET_MS = 250;          // still this long = the gesture is over
export const MIN_MS = 120;            // shorter is a bump (a firm tap is about 150 ms)
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
  static ALPHA_STILL = 0.3;            // ...and when the band is hardly turning: then the accelerometer IS gravity
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
      const off = Math.abs(mag - this.rest);
      if (off < 0.15) {                                 // the accelerometer is mostly gravity right now
        // Hardly turning and no push: trust the accelerometer a lot, so gravity catches up
        // within about 0.1 s after a gesture and the gesture can end.
        const alpha = Math.hypot(...w) < KEEP_GYRO && off < 0.05 ? Fusion.ALPHA_STILL : Fusion.ALPHA;
        const u = unit(a);
        g = g.map((x, i) => x * (1 - alpha) + u[i] * alpha);
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

/** Is the band moving at this fused sample? `start` = clearly, otherwise a little. */
export function isBusy(f, start = false) {
  const turning = Math.hypot(f.gx, f.gy, f.gz), moving = Math.hypot(f.lx, f.ly, f.lz);
  return start ? turning > START_GYRO || moving > START_LIN : turning > KEEP_GYRO || moving > KEEP_LIN;
}

/**
 * While teaching: the part of a recording window where the band moved, cut the same way
 * the Segmenter cuts (a short lead-in, up to the last moving sample). null = no movement.
 */
export function cutWindow(steps) {
  let first = steps.findIndex((f) => isBusy(f, true));
  if (first < 0) first = steps.findIndex((f) => isBusy(f));       // a gentle movement still counts
  if (first < 0) return null;
  let last = first;
  for (let i = first; i < steps.length; i++) if (isBusy(steps[i])) last = i;
  const from = steps[first].t - LEAD_IN_MS;
  const cut = steps.filter((f, i) => f.t >= from && i <= last + 1);
  return cut.length >= 2 ? cut : null;
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

// --- taps --------------------------------------------------------------------------------
// Measured on band 44 (data/recordings/calibration-20261114-161551.json, band on a wrist/desk):
// one tap is a cluster of spikes: the hit (2.2 to 2.7 g, cut off at the 2 g range), a rebound
// about 120 ms later at 55 to 65 % of the hit, and a small third spike at about 190 ms. The
// hit is 13 to 26 ms wide. Just before a tap the band is calm (turning 2 to 5 deg/s); during
// it the wrist jolts (500 to 1200 deg/s). An arm movement is already turning beforehand.
// So: a tap = a narrow spike out of calm; spikes in its ring count only if as strong as the hit.

/** Tap settings. calibrate() replaces them with the wearer's own. */
export const TAP_DEFAULTS = {
  threshold: 0.6,       // g: the hit is at least this sharp
  rebound: 0.8,         // inside the ring, a spike counts as a new tap only if this strong (x the hit)
  ringMs: 260,          // how long one tap rings
  maxGapMs: 1200,       // a longer gap ends the tap sequence (slow taps on band 44: about 850 ms apart)
  calmGyro: 80,         // deg/s: the arm must turn slower than this just before a tap
};
const SPIKE_MS = 15;      // the smoothing the spike is measured against
const SPIKE_MAX_MS = 90;  // a hit is narrower (13-26 ms, plus the hold); a longer spike is a push or a swing
const SPIKE_HOLD_MS = 15; // a hit rings, so it is over only after staying low this long
const LONG_MAX_MS = 250;  // after a long push, look for taps again after this at the latest
const CALM_FROM = 150, CALM_TO = 25;   // ms before the hit that must be calm

/** The spike signal of raw rows [t, ax, ay, az, ...] (or samples): how far each jumps from its recent average. */
export function spikes(rows) {
  const out = [];
  let low = null, lastT = null;
  for (const r of rows) {
    const [t, ax, ay, az] = Array.isArray(r) ? r : [r.t, r.ax, r.ay, r.az];
    if (low === null || t - lastT > 100 || t <= lastT) { low = [ax, ay, az]; lastT = t; out.push(0); continue; }
    const k = 1 - Math.exp(-(t - lastT) / SPIKE_MS);
    lastT = t;
    low = [low[0] + (ax - low[0]) * k, low[1] + (ay - low[1]) * k, low[2] + (az - low[2]) * k];
    out.push(Math.hypot(ax - low[0], ay - low[1], az - low[2]));
  }
  return out;
}

/** Finds taps in raw samples (416/s is best). feed() returns a tap { t, peak } or null. */
export class TapDetector {
  constructor(settings = TAP_DEFAULTS) { this.settings = { ...TAP_DEFAULTS, ...settings }; this.reset(); }
  reset() { this.low = null; this.lastT = null; this.open = null; this.long = false; this.last = null; this.impulse = 0; this.history = []; }
  feed(s) {
    const a = [s.ax, s.ay, s.az];
    if (!a.every(Number.isFinite) || !Number.isFinite(s.t)) return null;
    if (this.low === null || s.t <= this.lastT || s.t - this.lastT > 100) { this.reset(); this.low = a; this.lastT = s.t; return null; }
    const k = 1 - Math.exp(-(s.t - this.lastT) / SPIKE_MS);
    this.lastT = s.t;
    this.low = this.low.map((x, i) => x + (a[i] - x) * k);
    this.impulse = Math.hypot(a[0] - this.low[0], a[1] - this.low[1], a[2] - this.low[2]);
    const gyro = Number.isFinite(s.gx) ? Math.hypot(s.gx, s.gy, s.gz) : 0;
    this.history.push({ t: s.t, impulse: this.impulse, gyro });
    while (this.history.length && s.t - this.history[0].t > CALM_FROM + 50) this.history.shift();

    const { threshold } = this.settings;
    if (this.open) {                                   // inside a spike: follow it to its top
      this.open.peak = Math.max(this.open.peak, this.impulse);
      if (s.t - this.open.t > SPIKE_MAX_MS) { this.open = null; this.long = s.t; return null; }   // too wide for a hit
      if (this.impulse >= threshold * 0.5) { this.open.low = null; return null; }
      this.open.low ??= s.t;
      if (s.t - this.open.low < SPIKE_HOLD_MS) return null;       // a dip inside the ringing, not the end
      const spike = this.open;
      this.open = null;
      return this.decide(spike);
    }
    if (this.long) {
      if (this.impulse < threshold * 0.5 || s.t - this.long > LONG_MAX_MS) this.long = false;
      return null;
    }
    if (this.impulse > threshold) this.open = { t: s.t, peak: this.impulse, calm: this.calm(s.t) };
    return null;
  }
  /** Was the band calm just before time t? (no spikes, hardly turning) */
  calm(t) {
    const before = this.history.filter((h) => h.t >= t - CALM_FROM && h.t <= t - CALM_TO);
    if (!before.length) return true;
    const spike = Math.max(...before.map((h) => h.impulse));
    const turning = before.reduce((sum, h) => sum + h.gyro, 0) / before.length;
    return spike < this.settings.threshold * 0.6 && turning < this.settings.calmGyro;
  }
  decide(spike) {
    const { rebound, ringMs } = this.settings;
    // Right after a tap (its ring, and while its jolt fades) the band is never calm, so there a
    // spike is a new tap only if about as strong as that tap; the rebounds are much weaker.
    const near = this.last && spike.t - this.last.t < ringMs + CALM_FROM;
    const isTap = near ? spike.peak >= this.last.peak * rebound : spike.calm;
    if (!isTap) return null;
    this.last = { t: spike.t, peak: spike.peak };
    return { t: spike.t, peak: spike.peak };
  }
}

/** Groups taps into sequences. tick() returns { count, times } once a sequence is over. */
export class TapSequencer {
  constructor(settings = TAP_DEFAULTS) { this.settings = { ...TAP_DEFAULTS, ...settings }; this.times = []; }
  reset() { this.times = []; }
  add(tap) { this.times.push(tap.t); }
  get count() { return this.times.length; }
  get last() { return this.times.at(-1) ?? -Infinity; }
  tick(t) {
    if (!this.times.length || t - this.last <= this.settings.maxGapMs) return null;
    const done = { count: this.times.length, times: this.times };
    this.times = [];
    return done;
  }
}

/**
 * Is this stretch of fused steps only taps? True when there were taps and every moment the
 * band moved lies inside a tap's ring (so the "movement" is just the taps shaking the band).
 */
export function tapsOnly(steps, tapTimes, ringMs = TAP_DEFAULTS.ringMs, slackMs = 0) {
  if (!steps.length) return false;
  const inside = tapTimes.filter((t) => t >= steps[0].t - ringMs && t <= steps.at(-1).t + 80);
  if (!inside.length) return false;
  const outside = steps.filter((f) => isBusy(f, true) && !inside.some((t) => f.t >= t - 60 && f.t <= t + ringMs + 120));
  return outside.length * STEP_MS <= slackMs;      // moving clearly outside the taps for longer = a movement
}

/**
 * Calibration from four raw recordings, rows [t, ax, ay, az, gx, gy, gz]: still, slow taps,
 * fast taps, normal arm movement. Measures the wearer's taps. Returns { settings, warnings, taps }.
 */
export function calibrate({ still = [], slow = [], fast = [], move = [], more = [] }) {
  const pct = (list, q) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };
  const clamp = (x, lo, hi) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : NaN);
  const or = (x, fallback) => (Number.isFinite(x) ? x : fallback);
  const warnings = [];
  const noise = or(pct(spikes(still), 0.99), 0.05);

  // Each tap: the first strong spike out of calm; then its ring (rebound ratio, how long it rings).
  const clusters = [];
  for (const rows of [slow, fast, ...more]) {
    const imp = spikes(rows);
    const gyro = rows.map((r) => Math.hypot(r[4], r[5], r[6]));
    const found = [];
    for (let i = 1; i < rows.length - 1; i++) {
      if (!(imp[i] > Math.max(0.3, noise * 6) && imp[i] >= imp[i - 1] && imp[i] >= imp[i + 1])) continue;
      const t = rows[i][0];
      const last = found.at(-1);
      if (last && t - last.t < 450) {                       // part of the ring of the tap before
        if (t - last.t < 60) { last.peak = Math.max(last.peak, imp[i]); continue; }       // the same hit (a cut-off, flat top)
        if (imp[i] > last.peak * 0.9 && t - last.t >= 80) { found.push({ t, peak: imp[i], ring: [], calmGyro: 0 }); continue; }   // a new hit
        last.ring.push({ dt: t - last.t, ratio: imp[i] / last.peak });
        continue;
      }
      const before = gyro.filter((_, j) => rows[j][0] >= t - CALM_FROM && rows[j][0] <= t - CALM_TO);
      found.push({ t, peak: imp[i], ring: [], calmGyro: before.length ? before.reduce((p, q) => p + q, 0) / before.length : 0 });
    }
    clusters.push(found);
  }
  const [slowTaps, fastTaps] = clusters;
  const all = clusters.flat();
  if (slowTaps.length + fastTaps.length < 6) warnings.push(`${slowTaps.length + fastTaps.length} of 10 taps felt. Tap a little firmer and run it again`);

  const hits = all.map((c) => c.peak);
  const ring = all.flatMap((c) => c.ring);
  const gaps = (list) => list.slice(1).map((c, i) => c.t - list[i].t);
  const slowGap = pct(gaps(slowTaps), 0.5);
  const fastGap = pct(gaps(fastTaps), 0.1);
  const strongRing = ring.filter((r) => r.ratio > 0.1);
  const settings = {
    threshold: clamp(Math.max(noise * 5, pct(hits, 0.1) * 0.4), 0.25, 3) || TAP_DEFAULTS.threshold,
    rebound: clamp(Math.max(...ring.map((r) => r.ratio), 0) + 0.15, 0.6, 0.92) || TAP_DEFAULTS.rebound,
    ringMs: clamp(Math.min(Math.max(...strongRing.map((r) => r.dt), 150) + 40, or(fastGap, Infinity) * 0.8), 150, 350) || TAP_DEFAULTS.ringMs,
    maxGapMs: clamp(slowGap * 1.4, 450, 1500) || TAP_DEFAULTS.maxGapMs,
    calmGyro: clamp(pct(all.map((c) => c.calmGyro), 0.9) * 5 + 30, 50, 200) || TAP_DEFAULTS.calmGyro,
  };
  if (Number.isFinite(fastGap) && fastGap < settings.ringMs) warnings.push('The fast taps run together. Leave a little more room between them');
  return { settings, warnings, taps: { slow: slowTaps.length, fast: fastTaps.length } };
}

/**
 * Raw band samples in, finished gestures out. `step` is the newest fused sample (for a live
 * picture), `reading` is true while a gesture is being cut, `ready` once the arm was still long enough.
 */
export class MotionReader {
  constructor(tapSettings = TAP_DEFAULTS) {
    this.smoother = new Smoother(); this.fusion = new Fusion(); this.segmenter = new Segmenter();
    this.step = null; this.tap = null; this.tapTimes = [];
    this.setTaps(tapSettings);
  }
  setTaps(settings) { this.tapSettings = { ...TAP_DEFAULTS, ...settings }; this.taps = new TapDetector(this.tapSettings); }
  reset() { this.smoother.reset(); this.segmenter.reset(); this.taps.reset(); this.fusion.lastT = null; this.step = null; this.tapTimes = []; }   // keeps the learned bias
  get reading() { return this.segmenter.samples !== null; }
  get ready() {
    const s = this.segmenter;
    return !this.reading && this.step !== null && s.stillSince !== null && s.busySince === null && this.step.t - s.stillSince >= STILL_BEFORE_MS;
  }
  /** Returns a finished movement gesture or null. A tap found in this sample is in `this.tap`. */
  feed(raw) {
    this.tap = this.taps.feed(raw);
    if (this.tap) {
      this.tapTimes.push(this.tap.t);
      while (this.tapTimes.length > 20) this.tapTimes.shift();
    }
    const step = this.smoother.feed(raw);
    if (!step) return null;
    this.step = this.fusion.feed(step);
    const gesture = this.segmenter.feed(this.step);
    if (gesture && tapsOnly(gesture, this.tapTimes, this.tapSettings.ringMs)) return null;   // the taps handle it
    return gesture;
  }
}

// --- the shape of a movement, relative to the wearer ----------------------------------------
// Everything is measured from where the movement starts, in a frame tied to the wearer:
//   up       = against gravity at the start
//   forward  = the way the forearm points at the start (the band's x axis, made level)
//   left     = up x forward
// The band turns during a movement; the gyro tells how much, so every sample is turned back
// into that start frame. Then only changes are compared, never positions:
//   speed    how fast the hand moves, and which way (the push, added up; it starts and ends
//            at rest, so whatever is left at the end is sensor drift and is taken out)
//   turn     how far the wrist has turned since the start (the gyro, added up)
//   push     the push itself (acceleration without gravity)
// So "left" is left of the wearer however the wrist is turned or the arm is held.
export const SPEED_SCALE = 0.08;      // g·s (about 0.8 m/s) counts as much as...
export const TURN_SCALE = 1.2;        // ...this many radians of turning (about 70°), and as...
export const PUSH_SCALE = 0.6;        // ...this many g of push

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Rotation matrix for a small turn w (radians, the band's own axes), Rodrigues' formula. */
function turnBy(w) {
  const angle = Math.hypot(...w);
  if (angle < 1e-9) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = w.map((v) => v / angle), c = Math.cos(angle), s = Math.sin(angle), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
const times = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const apply = (A, v) => A.map((row) => dot(row, v));

/** The wearer's frame at the start of a movement: [forward, left, up], in the band's axes then. */
export function userFrame(first) {
  const up = unit([first.ux, first.uy, first.uz]);
  let forward = null;
  for (const axis of [[1, 0, 0], [0, 0, 1], [0, 1, 0]]) {          // the forearm, or the next best level axis
    const level = axis.map((v, i) => v - dot(axis, up) * up[i]);
    if (Math.hypot(...level) > 0.4) { forward = unit(level); break; }
  }
  return [forward, cross(up, forward), up];
}

/** Each sample of a movement as [speed 3, turn 3, push 3] in the wearer's start frame. */
export function relative(gesture) {
  const frame = userFrame(gesture[0]);
  let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];                         // band now -> band at the start
  let speed = [0, 0, 0], turn = [0, 0, 0];
  const out = [];
  for (let i = 0; i < gesture.length; i++) {
    const f = gesture[i];
    const dt = i ? (f.t - gesture[i - 1].t) / 1000 : 0;
    const rate = [f.gx, f.gy, f.gz].map((v) => (v * Math.PI) / 180);
    if (i) R = times(R, turnBy(rate.map((v) => v * dt)));
    const push = apply(frame, apply(R, [f.lx, f.ly, f.lz]));
    const spin = apply(frame, apply(R, rate));
    speed = speed.map((v, k) => v + push[k] * dt);
    turn = turn.map((v, k) => v + spin[k] * dt);
    out.push({ t: f.t, speed: [...speed], turn: [...turn], push });
  }
  // The hand is at rest at both ends, so the speed must end at 0: what is left is drift.
  const t0 = out[0].t, span = Math.max(1, out.at(-1).t - t0), drift = out.at(-1).speed;
  for (const o of out) o.speed = o.speed.map((v, k) => v - drift[k] * ((o.t - t0) / span));
  return out;
}

/** A movement as POINTS x FEATURES numbers (speed, turn, push), spread evenly over its time. */
export function toShape(gesture) {
  const rel = relative(gesture);
  const vec = (o) => [...o.speed.map((v) => v / SPEED_SCALE), ...o.turn.map((v) => v / TURN_SCALE), ...o.push.map((v) => v / PUSH_SCALE)];
  const start = rel[0].t, length = rel.at(-1).t - start;
  const shape = [];
  let i = 0;
  for (let p = 0; p < POINTS; p++) {
    const t = start + (length * p) / (POINTS - 1);
    while (i < rel.length - 2 && rel[i + 1].t < t) i++;
    const a = rel[i], b = rel[i + 1] ?? a;
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

/**
 * How sure a recognised movement is, 0..1, for the guardian's app (it holds back words below
 * 0.8 as doubtful). Near an example and well clear of the runner-up = above 0.9; close to the
 * word's limit (score 1) or to the runner-up = below 0.8. Taps are exact and get 1.
 */
export function confidenceOf(result) {
  if (!result?.id) return 0;
  const score = result.best.score;
  const near = 1 - 0.5 * score * score;                               // 0.3 -> 0.96, 0.6 -> 0.82, 1 -> 0.5
  const ratio = result.next ? result.next.score / Math.max(score, 1e-6) : Infinity;
  const clear = Math.min(1, 0.75 + Math.max(0, ratio - MARGIN) * 0.36);   // runner-up just past the margin -> 0.75, 2x -> 1
  return Math.max(0, Math.min(1, near * clear));
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
