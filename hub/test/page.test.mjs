// The band page in headless Chrome with the pretend band, against the real hub/server.py:
// calibrate, teach a movement and two tap words (fast and slow taps mixed), recognise each,
// cancel with 2 taps, reject an untaught motion.
//   node --test hub/test/page.test.mjs        (needs Chrome; skipped without it; about 100 s)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skip, startChrome, sleep } from '../../vexo-open-kit/projects/test/chrome.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 8200 + Math.floor(Math.random() * 500);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
let server, chrome;

before(async () => {
  if (skip) return;
  server = spawn('python3', ['hub/server.py', '--local', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${ORIGIN}/api/info`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  chrome = await startChrome();
});
after(async () => {
  await chrome?.close();
  server?.kill();
});

test('calibrate, teach, recognise movements and tap counts, cancel', { skip, timeout: 240000 }, async () => {
  const page = await chrome.openPage(`${ORIGIN}/hub/sources/band/?link=pretend`);
  await page.run('localStorage.clear()');
  await page.click('#connect');
  const txt = (s) => page.text(s);
  await page.until('calib view', '!document.querySelector("#calib-view").hidden');
  console.log(at(), 'calibration:', await txt('#calib-title'));
  await page.untilText('#calib-title', /slowly/, 6000);
  await page.click('#pretend-taps3slow'); await sleep(2200); await page.click('#pretend-taps3slow');
  await page.untilText('#calib-title', /quickly/, 6000); console.log(at(), 'slow taps felt -> next step');
  await page.click('#pretend-taps3'); await sleep(700); await page.click('#pretend-taps3');
  await page.untilText('#calib-title', /move your arm/, 6000); console.log(at(), 'fast taps felt -> next step');
  await page.click('#pretend-circle'); await sleep(1500); await page.click('#pretend-shake');
  await page.untilText('#calib-title', /Calibrated/, 8000); console.log(at(), 'Calibrated |', await txt('#calib-hint'));
  await page.until('teach view', '!document.querySelector("#teach-view").hidden', 6000);

  async function teachWord(buttons) {
    for (let k = 0; k < 3; k++) {
      await page.until('Go', '/^Go/.test(document.querySelector("#teach-phase").textContent)', 9000);
      await page.click(`#pretend-${buttons[k]}`);
      await page.until(`try ${k + 1}`, `document.querySelectorAll('#teach-dots .done').length >= ${k + 1} || /Got it ✓/.test(document.querySelector('#teach-phase').textContent) || /Let’s|Pick|already/.test(document.querySelector('#teach-note').textContent)`, 9000);
      console.log(at(), '  ', buttons[k], '->', await txt('#teach-note') || await txt('#teach-phase'));
    }
  }
  console.log(at(), await txt('#teach-title')); await teachWord(['circle', 'circle', 'circle']);
  await page.untilText('#teach-title', /Food/, 4000);
  console.log(at(), await txt('#teach-title')); await teachWord(['taps3', 'taps3slow', 'taps3']);
  await page.untilText('#teach-title', /Parents/, 4000); assert.equal(await page.run('JSON.parse(localStorage.getItem("epsilon-examples-v2")).tapWords.food'), 3, 'fast and slow taps are both 3');
  console.log(at(), await txt('#teach-title')); await teachWord(['taps2', 'taps2', 'taps2']);
  await page.untilText('#teach-title', /Sleep/, 4000);
  for (let i = 0; i < 2; i++) { await page.click('#teach-skip'); await sleep(100); }
  await page.until('use view', '!document.querySelector("#use-view").hidden', 4000);
  assert.match(await page.run('[...document.querySelectorAll(".tile")].map(b=>b.textContent).join(" / ")'), /Water.*movement.*Food.*3 taps.*Parents.*2 taps/);
  console.log(at(), 'USE | tiles:', await page.run('[...document.querySelectorAll(".tile")].map(b=>b.textContent).join(" / ")'));
  const expect = async (button, re, label) => {
    await page.untilText('#card-title', /^Ready$/, 8000); await sleep(600); await page.click(`#pretend-${button}`);
    await page.untilText('#card-title', re, 5000);
  };
  await expect('circle', /Water/, 'circle');
  await page.untilText('#card-title', /sent/, 5000);
  await expect('taps3slow', /Food/, '3 slow taps');
  await page.untilText('#card-title', /sent/, 5000);
  await expect('taps3', /Food/, '3 fast taps');
  await page.untilText('#card-title', /sent/, 5000);
  await expect('taps2', /Parents/, '2 taps');
  await page.untilText('#card-title', /sent/, 5000);
  await expect('taps4', /4 taps/, '4 taps (no word)');
  await expect('circle', /Water/, 'circle again');
  await sleep(200); await page.click('#pretend-taps2');
  await page.untilText('#card-title', /Cancelled/, 3000); console.log(at(), '2 taps while pending:', await txt('#card-title'));
  await expect('punch', /catch/, 'punch (untaught)');
  const sent = (await fetch(`${ORIGIN}/api/messages`).then((r) => r.json())).map((m) => `${m.id}/${m.via}`);
  assert.deepEqual(sent, ['water/gesture', 'food/taps', 'food/taps', 'parents/taps']);
  assert.deepEqual(page.problems, [], 'no errors in the page');
});
