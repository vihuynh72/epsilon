// Five pretend-hand motions for testing without a band: the kit's four plus a "raise".
// Each says what the sensor reads `s` seconds into the motion (g and degrees/second).
// Record each one 3 times for a word, then press it again to see it recognised.
import { MOTIONS } from '../../../vexo-open-kit/projects/gesture-trainer/motions.js';

export const PRETEND = {
  ...MOTIONS,
  // Lift the forearm and put it down again: the wrist turns about one axis, gravity shifts.
  raise: [(s) => ({ gy: -260 * Math.sin(2 * Math.PI * s / 1.2), ax: 0.8 * Math.sin(Math.PI * s / 1.2), az: 1 - 0.5 * Math.sin(Math.PI * s / 1.2) }), 1.2],
};

// One tap on the band: a short ringing spike in acceleration with a little wobble.
// Play it with pretend.playMotion(...PRETEND_TAP), then a rest for the gap to the next tap.
export const PRETEND_TAP = [(s) => {
  const ms = s * 1000;
  const ring = (d, a) => (d >= 0 && d < 60 ? a * Math.exp(-d / 10) * Math.cos(2 * Math.PI * d / 28) : 0);
  // like band 44's real taps: the hit, a rebound at 120 ms, a small spike at 190 ms, a wrist jolt
  return { az: 1 + ring(ms, 2.4) + ring(ms - 120, 1.4) + ring(ms - 190, 0.24), gx: ms < 200 ? 800 * Math.exp(-ms / 40) * Math.sin(2 * Math.PI * ms / 80) : 0 };
}, { seconds: 0.25 }];
