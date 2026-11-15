// The band's microphone, turned into what Vi's sound matcher (sound-match.js) reads: one frame
// every 40 ms of 20 loudness values (dB), log-spaced bands from 100 Hz to 6 kHz. Same frames
// as the Sounds page gets from the laptop's microphone, so taught sounds mean the same thing.
// No sound is kept: only the frames while they are needed, and the fingerprint.
import { BANDS } from './sound-match.js';

const RATE = 16000;              // the band's microphone
const FRAME = 640;               // 40 ms
const FFT = 1024;
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => 100 * (6000 / 100) ** (i / BANDS));
const BIN_HZ = RATE / FFT;
const WINDOW = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));

/** In-place radix-2 FFT of (re, im), length a power of two. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/** One 40 ms frame of samples -> BANDS loudness values in dB. */
export function frameOf(samples) {
  const re = new Float64Array(FFT), im = new Float64Array(FFT);
  for (let i = 0; i < FRAME; i++) re[i] = (samples[i] ?? 0) * WINDOW[i];
  fft(re, im);
  const out = [];
  for (let b = 0; b < BANDS; b++) {
    const from = Math.max(1, Math.floor(EDGES[b] / BIN_HZ)), to = Math.max(from + 1, Math.ceil(EDGES[b + 1] / BIN_HZ));
    let sum = 0;
    for (let k = from; k < to; k++) sum += 10 * Math.log10((re[k] ** 2 + im[k] ** 2) / FRAME + 1e-12);
    out.push(sum / (to - from));
  }
  return out;
}

/**
 * Takes the band's samples (Float32Array, any length), makes 40 ms frames, and cuts out sounds:
 * louder than the recent quiet level by 10 dB, ended by 320 ms of quiet, at most 3 s.
 * onFrame(frame) gets every frame (for teaching); onSound(frames) every sound cut out (for listening).
 */
export class SoundFrames {
  constructor({ onFrame = () => {}, onSound = () => {} } = {}) {
    Object.assign(this, { onFrame, onSound });
    this.reset();
  }
  reset() { this.buffer = []; this.levels = []; this.sound = null; this.quietFor = 0; this.before = []; }
  push(samples) {
    for (const v of samples) {
      this.buffer.push(v);
      if (this.buffer.length === FRAME) {
        const power = this.buffer.reduce((sum, x) => sum + x * x, 0) / FRAME;
        this.frame(frameOf(this.buffer), 10 * Math.log10(power + 1e-12));     // overall loudness, dB
        this.buffer = [];
      }
    }
  }
  frame(f, level) {
    this.onFrame(f, level);
    this.levels.push(level);
    if (this.levels.length > 75) this.levels.shift();                   // the last 3 s
    const quiet = [...this.levels].sort((a, b) => a - b)[Math.floor(this.levels.length * 0.1)];
    const loud = this.levels.length >= 10 && level > quiet + 10;
    if (!this.sound) {
      this.before.push(f);
      if (this.before.length > 2) this.before.shift();
      if (loud) { this.sound = [...this.before]; this.quietFor = 0; }
      return;
    }
    this.sound.push(f);
    this.quietFor = loud ? 0 : this.quietFor + 1;
    if (this.quietFor >= 8 || this.sound.length > 75) {
      const done = this.sound;
      this.sound = null;
      this.before = [];
      if (done.length <= 75) this.onSound(done);
    }
  }
}
