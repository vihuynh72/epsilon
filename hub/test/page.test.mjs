// The band page in headless Chrome with the pretend band, against the real hub/server.py.
//   node --test hub/test/page.test.mjs        (needs Chrome; skipped without it)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skip, startChrome, sleep } from '../../vexo-open-kit/projects/test/chrome.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 8200 + Math.floor(Math.random() * 500);
const ORIGIN = `http://127.0.0.1:${PORT}`;
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

const sent = () => fetch(`${ORIGIN}/api/messages`).then((r) => r.json());

test('record two words, recognise them, cancel one, triple-tap Help, the words reach the server', { skip, timeout: 120000 }, async () => {
  const page = await chrome.openPage(`${ORIGIN}/hub/sources/band/?link=pretend`);
  await page.run('localStorage.clear()');
  assert.equal(await page.run('document.querySelector("#number").value'), '44');
  await page.connectPretend();
  assert.match(await page.text('#message'), /Vexo-HACK-44/);

  const row = (i) => `#words tr:nth-child(${i + 1})`;
  const examples = (i) => page.text(`${row(i)} td:nth-child(2)`);
  async function teach(i, move) {
    await page.click(`${row(i)} td:nth-child(3) button`);           // record
    for (const left of [2, 1, 0]) {
      await page.click(`#pretend-${move}`);
      await page.until(`${move} recorded`, `/^(recording, ${left} to go|3)$/.test(document.querySelector("${row(i)} td:nth-child(2)").textContent)`);
      await sleep(400);                                             // the rest after the motion
    }
    assert.equal(await examples(i), '3');
  }
  await teach(0, 'circle');                                         // Water
  await teach(1, 'shake');                                          // Food
  await page.untilText(`${row(0)} td:nth-child(6)`, /^ok 3\/3$/);
  await page.untilText(`${row(1)} td:nth-child(6)`, /^ok 3\/3$/);

  // Recognise and send
  await page.click('#pretend-circle');
  await page.untilText('#status', /Water\?$/);
  await page.untilText('#status', /Water: sent$/, 6000);
  await page.click('#pretend-shake');
  await page.untilText('#status', /Food\?$/);
  // Double-tap cancels it
  await page.click('#pretend-double');
  await page.untilText('#status', /^Cancelled$/);
  await sleep(2500);
  // A motion nobody recorded
  await page.click('#pretend-punch');
  await page.untilText('#status', /^Not sure$/);
  // Three taps: Help, at once
  await sleep(2100);
  for (const kind of ['tap', 'tap', 'tap']) { await page.click(`#pretend-${kind}`); await sleep(150); }
  await page.untilText('#status', /Help: sent$/);

  const words = (await sent()).map((m) => `${m.id}/${m.via}`);
  assert.deepEqual(words, ['water/gesture', 'help/taps']);
  assert.deepEqual(await page.run('JSON.parse(localStorage.getItem("epsilon-examples-v1")).water.length'), 3, 'examples kept for a reload');
  assert.deepEqual(page.problems, [], 'no errors in the page');
});
