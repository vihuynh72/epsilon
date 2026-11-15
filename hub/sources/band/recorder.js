// Recording for tuning. Two streams, both sent to the server, which keeps them in
// data/recordings/ on this laptop (git ignores that folder; nothing leaves the laptop):
//
//   gestures-<session>   one entry per thing the page decided: a movement it read, a tap
//                        sequence, a try while teaching, a word sent or cancelled. Each entry
//                        carries the raw motion around it (from 0.3 s before to 0.3 s after).
//   raw-<session>        everything the band sent, in 30 s chunks, when the full log is on.
//
// Rows are [t, ax, ay, az, gx, gy, gz]: band time in ms, acceleration in g, turning in deg/s.
// Both streams are gzip-compressed JSON (about 150 kB per 30 s of raw motion at 416/s).

const RING_MS = 8000;         // raw motion kept for clips
const FLUSH_MS = 30000;
const FLUSH_EVENTS = 12;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r1 = (x) => Math.round(x * 10) / 10;

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
// local time, e.g. 20261114-1700
export const SESSION = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

export class Recorder {
  /** `log(line)` reports what was saved; `context()` adds settings to each saved file. */
  constructor({ log = () => {}, context = () => ({}) } = {}) {
    Object.assign(this, { log, context });
    this.ring = [];
    this.chunk = [];
    this.events = [];
    this.nextId = 1;
    this.fullLog = true;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    addEventListener('pagehide', () => this.flush(true));
  }

  /** Every raw sample from the band. */
  sample(s) {
    const row = [r1(s.t), r4(s.ax), r4(s.ay), r4(s.az), r1(s.gx ?? 0), r1(s.gy ?? 0), r1(s.gz ?? 0)];
    this.ring.push(row);
    while (this.ring.length && row[0] - this.ring[0][0] > RING_MS) this.ring.shift();
    if (this.fullLog) this.chunk.push(row);
  }

  /** The raw rows between two band times. */
  clip(from, to) {
    return this.ring.filter((r) => r[0] >= from && r[0] <= to);
  }

  /**
   * Log one decision. `around` = [from, to] in band time: the raw motion of that stretch is
   * attached, padded by 0.3 s. Returns the entry's id, so a later "sent" or "cancelled" can
   * point back at it.
   */
  event(entry, around = null) {
    const id = this.nextId++;
    const e = { id, at: new Date().toISOString(), ...entry };
    if (around) e.raw = this.clip(around[0] - 300, around[1] + 300);
    this.events.push(e);
    if (this.events.length >= FLUSH_EVENTS) this.flush();
    return id;
  }

  async flush(leaving = false) {
    const events = this.events.splice(0);
    const chunk = this.chunk.splice(0);
    const columns = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'];
    if (events.length) this.save(`gestures-${SESSION}`, { session: SESSION, columns, ...this.context(), events }, leaving);
    if (chunk.length) this.save(`raw-${SESSION}`, { session: SESSION, columns, ...this.context(), rows: chunk }, leaving);
  }

  async save(name, data, leaving) {
    try {
      const body = await gzip(JSON.stringify(data));
      const r = await fetch(`/api/recording?name=${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip', 'X-Epsilon': '1' },
        body,
        keepalive: leaving && body.size < 60000,
      });
      const answer = await r.json();
      if (!leaving) this.log(`saved ${answer.saved}`);
    } catch (e) {
      if (!leaving) this.log(`not saved (${name}): ${e.message}`);
    }
  }
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}
