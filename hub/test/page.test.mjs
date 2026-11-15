// The band page in headless Chrome with the pretend band, against the real hub/server.py, which
// forwards to a fake guardian app. Covers: first visit (reference recording, skippable),
// teaching 1/2/3 taps and a movement, recognising each, cancelling with 2 taps, ignoring an
// untaught motion, the "Send to the guardian app" switch off and on, and the logs saved.
//   node --test hub/test/page.test.mjs        (needs Chrome; skipped without it; about 2 minutes)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { skip, startChrome, sleep } from '../../vexo-open-kit/projects/test/chrome.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RECORDINGS = `${ROOT}data/recordings/`;
const PORT = 8200 + Math.floor(Math.random() * 500);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TAPS = { threshold: 0.6, rebound: 0.8, ringMs: 260, maxGapMs: 1200, calmGyro: 80 };
let server, chrome, app, before0;
const appGot = [];

before(async () => {
  if (skip) return;
  before0 = new Set(safeList());
  app = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { appGot.push({ path: req.url, body: JSON.parse(b) }); res.end('{"ok":true}'); }); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  server = spawn('python3', ['hub/server.py', '--local', '--port', String(PORT), '--forward', `http://127.0.0.1:${app.address().port}/gesture?k=test`], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${ORIGIN}/api/info`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  chrome = await startChrome();
});
after(async () => {
  await chrome?.close();
  server?.kill();
  app?.close();
  for (const f of safeList()) if (!before0?.has(f)) rmSync(RECORDINGS + f, { force: true });   // only what this test wrote
});
function safeList() { try { return readdirSync(RECORDINGS); } catch { return []; } }

async function open(seedTaps) {
  const page = await chrome.openPage(`${ORIGIN}/hub/sources/band/?link=pretend`);
  await page.run(`localStorage.clear(); ${seedTaps ? `localStorage.setItem('epsilon-taps-v1', '${JSON.stringify(TAPS)}');` : ''} location.reload()`);
  await sleep(1500);
  await page.until('the page', 'document.querySelector("#connect") && document.querySelector("#needs-server").hidden');
  await page.click('#connect');
  return page;
}

test('first visit: the reference recording starts on the wrist, every step can be skipped, then teaching', { skip, timeout: 120000 }, async () => {
  const page = await open(false);
  await page.until('reference view', '!document.querySelector("#calib-view").hidden');
  assert.match(await page.text('#calib-step'), /^Step 1 of 3\d$/);
  assert.match(await page.text('#calib-title'), /Wear the band/);
  for (let i = 0; i < 40 && (await page.run('document.querySelector("#teach-view").hidden')); i++) {
    if (/^Recorded|^Calibrated/.test(await page.text('#calib-title'))) { await sleep(300); continue; }
    await page.click('#calib-skip');
    await sleep(60);
  }
  await page.until('teach view', '!document.querySelector("#teach-view").hidden', 8000);
  assert.match(await page.text('#log'), /accelerometer: ±8 g/);
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('taps and movements as words, recognised, cancelled, ignored; switch off and on; logs saved', { skip, timeout: 300000 }, async () => {
  const page = await open(true);
  await page.until('teach view', '!document.querySelector("#teach-view").hidden', 8000);
  async function teachWord(button) {
    for (let k = 0; k < 3; k++) {
      await page.until('Now', '/^Now/.test(document.querySelector("#teach-phase").textContent)', 9000);
      await page.click(`#pretend-${button}`);
      await page.until(`try ${k + 1}`, `document.querySelectorAll('#teach-dots .done').length >= ${k + 1} || /Saved/.test(document.querySelector('#teach-phase').textContent)`, 9000);
    }
  }
  for (const [title, button] of [[/Water/, 'taps1'], [/Food/, 'taps2'], [/Parents/, 'taps3'], [/Sleep/, 'circle']]) {
    await page.untilText('#teach-title', title, 6000);
    await teachWord(button);
  }
  await page.untilText('#teach-title', /Help/, 6000);
  await page.click('#teach-skip');
  await page.until('use view', '!document.querySelector("#use-view").hidden', 4000);
  const stored = await page.run('JSON.parse(localStorage.getItem("epsilon-examples-v3"))');
  assert.deepEqual(stored.tapWords, { water: 1, food: 2, parents: 3 });
  assert.equal(stored.taught.sleep.length, 3, 'sleep is a movement with 3 examples');
  assert.equal(await page.run('document.querySelectorAll(".tile svg").length'), 5, 'every word has an icon');

  const expect = async (button, re) => {
    await page.untilText('#card-title', /^Ready$/, 8000);
    await sleep(500);
    await page.click(`#pretend-${button}`);
    await page.untilText('#card-title', re, 6000);
  };
  // switch off: words stay on this laptop
  assert.equal(await page.run('document.querySelector("#to-app").checked'), false, 'off by default');
  for (const [button, word] of [['taps1', 'Water'], ['taps2', 'Food'], ['taps3', 'Parents'], ['taps3slow', 'Parents'], ['circle', 'Sleep']]) {
    await expect(button, new RegExp(`^${word}$`));
    await page.until(`${word} sent`, '/sent/.test(document.querySelector("#card").className)', 5000);
  }
  assert.equal(appGot.length, 0, 'nothing forwarded while the switch is off');
  await expect('taps4', /^4 taps$/);                          // no word uses 4 taps
  await expect('circle', /^Sleep$/);
  await sleep(200);
  await page.click('#pretend-taps2');                          // 2 taps while it waits = cancel
  await page.untilText('#card-title', /^Cancelled$/, 4000);
  await expect('punch', /^Not recognised$/);                   // never taught
  // switch on: words go to the app
  await page.click('#to-app');
  await expect('taps1', /^Water$/);
  await page.untilText('#card-hint', /^Delivered$/, 6000);
  assert.equal(appGot.length, 1);
  assert.equal(appGot[0].path, '/gesture?k=test');
  assert.equal(appGot[0].body.id, 'water');
  assert.equal(appGot[0].body.via, 'taps');
  assert.equal(appGot[0].body.confidence, 1);

  const sent = await fetch(`${ORIGIN}/api/messages`).then((r) => r.json());
  assert.deepEqual(sent.map((m) => `${m.id}/${m.via}`), ['water/taps', 'food/taps', 'parents/taps', 'parents/taps', 'sleep/gesture', 'water/taps']);
  assert.ok(sent.every((m) => m.confidence >= 0 && m.confidence <= 1), 'every word has a confidence');

  await page.run('dispatchEvent(new Event("pagehide"))');      // flush the logs now instead of in 30 s
  await sleep(1500);
  const files = safeList().filter((f) => !before0.has(f));
  assert.ok(files.some((f) => /^gestures-.*\.json\.gz$/.test(f)), `gesture log saved (${files})`);
  assert.ok(files.some((f) => /^raw-.*\.json\.gz$/.test(f)), 'raw log saved');
  assert.deepEqual(page.problems, [], 'no errors in the page');
});
