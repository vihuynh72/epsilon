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
  return { az: 1 + 1.0 * Math.exp(-ms / 6) * Math.cos(2 * Math.PI * ms / 10), gx: 15 * Math.exp(-ms / 10) };
}, { seconds: 0.04 }];
