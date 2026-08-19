/**
 * Two independent browsers on the same session page. One registers; the other
 * must update with no reload and no poll (the poll interval is 30s, so any
 * change inside a few seconds can only have come over SSE).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearTestMembers,
  localClaimPath,
  localGroupJoinPath,
  localOrganizerId,
  localUnclaimedMember,
} from './helpers.mjs';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = process.env.SHOTS_DIR ?? '/tmp/ff-shots';
// Point at a deployment with APP_URL; defaults to local dev.
const APP_URL = (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (label, ok, detail) => {
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `\n         ${detail}`}`);
};

let nextId = 1;
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, ready };
}

/** Every browser this run started, so a crash cannot leave one holding a port. */
const launched = [];
const killAll = () => { for (const p of launched) { try { p.kill(); } catch {} } };

async function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), `ff-live-${port}-`));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  launched.push(proc);

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await sleep(200);
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const { send, ready } = connect(target.webSocketDebuggerUrl);
  await ready;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  // This suite finds buttons by their English labels, and a member's stored
  // language follows them onto any device. Pin the device choice, which
  // outranks the server value, so the run does not depend on whose account it
  // happens to sign in as.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('futsal:locale', 'en'); } catch {}`,
  });

  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  };
  const waitFor = async (expr, label, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(150); }
    if (label) check(label, false, `timeout: ${expr}`);
    return false;
  };
  const shoot = async (n) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT_DIR, `${n}.png`), Buffer.from(data, 'base64'));
  };
  return { proc, send, js, waitFor, shoot };
}

/**
 * The organizer signs in with a personal link — the group link deliberately
 * never lists an organizer, which is the whole reason it is safe to paste in a
 * chat.
 */
async function signInOrganizer(b) {
  await b.send('Page.navigate', { url: `${APP_URL}${localClaimPath(localOrganizerId())}` });
  await b.waitFor('!!document.querySelector(".bottom-nav")', 'Organizer: shell');
  await sleep(2500);
  check('Organizer: link secret left the address bar', (await b.js('location.hash')) === '',
    await b.js('location.hash'));
}

/** Everybody else takes a name off the one group link. */
async function signInViaGroup(b, who, joinPath) {
  await b.send('Page.navigate', { url: `${APP_URL}${joinPath}` });
  await b.waitFor('document.body.innerText.includes("Which one are you")', `${who}: picker`);
  const clicked = await b.js(`(() => {
    const btns = [...document.querySelectorAll('md-outlined-button')];
    const b = btns.find(x => x.textContent.includes(${JSON.stringify(who)}));
    if (b) { b.click(); return true; } return false;
  })()`);
  check(`${who}: signed in`, clicked);
  await b.waitFor('!!document.querySelector(".bottom-nav")', `${who}: shell`);
  await sleep(2500);
  check(`${who}: group nonce left the address bar`, (await b.js('location.hash')) === '',
    await b.js('location.hash'));
}

const playing = (b) => b.js('Number(document.body.innerText.match(/Playing (\\d+)/)?.[1] ?? -1)');
const connState = (b) => b.js(`document.querySelector('.conn')?.className ?? 'none'`);

async function run() {
  console.log('\nlaunching two browsers');
  // See the note on ports in the other suites: a stray Chrome on a fixed port
  // would serve these two "independent" browsers one shared, signed-in profile.
  const base = 9400 + ((process.pid % 30) * 2);
  const a = await launch(base);
  const bb = await launch(base + 1);

  clearTestMembers();
  const player = 'Rita Realtime-Test';
  localUnclaimedMember(player);
  const joinPath = localGroupJoinPath();

  await signInOrganizer(a);
  await signInViaGroup(bb, player, joinPath);

  console.log('\nboth connect live');
  await a.waitFor(`document.querySelector('.conn')?.className.includes('live')`, 'A reaches live');
  await bb.waitFor(`document.querySelector('.conn')?.className.includes('live')`, 'B reaches live');
  check('A is live over SSE', (await connState(a)).includes('live'), await connState(a));
  check('B is live over SSE', (await connState(bb)).includes('live'), await connState(bb));

  // Normalise: A must be *out* before we measure a join, and the run before
  // this one may well have left them in. Assert it rather than assuming —
  // starting from the wrong state makes every check below pass vacuously while
  // measuring nothing.
  //
  // Both directions go through the pitch: there is no register button any more.
  // Leaving is two presses, because an unlabelled circle with your own face on
  // it asks again before giving up a place.
  const press = (sel) => `(() => {
    const s = document.querySelector(${JSON.stringify(sel)});
    if (!s) return false; s.click(); return true;
  })()`;
  const pressMine = press('button.pitch-spot.is-me');
  const pressOpen = press('button.pitch-spot.is-open');
  const canJoin = `!!document.querySelector('button.pitch-spot.is-open')`;

  if (await a.js(pressMine)) {
    await sleep(400);
    await a.js(pressMine);
    await sleep(2000);
  }
  check('A starts out not registered', await a.waitFor(canJoin, 'A can register'));

  // And B has to have caught up with that before it becomes the baseline.
  await sleep(1500);
  const beforeB = await playing(bb);
  console.log(`\nB sees ${beforeB} playing; A registers now`);

  await a.js(pressOpen);

  // Poll every 250ms for up to 6s. The polling fallback is 30s, so anything
  // arriving in this window came through the realtime stream.
  let afterB = beforeB;
  const start = Date.now();
  while (Date.now() - start < 6000) {
    afterB = await playing(bb);
    if (afterB !== beforeB) break;
    await sleep(250);
  }
  const elapsed = Date.now() - start;

  check('B saw the join without reloading', afterB === beforeB + 1, `before=${beforeB} after=${afterB}`);
  check('and it arrived over SSE, not the 30s poll', afterB === beforeB + 1 && elapsed < 6000, `${elapsed}ms`);
  console.log(`         (propagated in ${elapsed}ms)`);
  // Look inside the player list, not the whole page — the signed-in name sits
  // in the top bar, so a body-text match would pass without B updating at all.
  check("B's list now contains the new player",
    await bb.js(`[...document.querySelectorAll('.player-row')].some(r => r.textContent.includes('Organizer'))`),
    await bb.js(`[...document.querySelectorAll('.player-row')].map(r => r.textContent.trim()).join('|')`));

  check("and B's pitch drew the arriving spot",
    await bb.js(`[...document.querySelectorAll('.pitch-spot')]
      .some(s => (s.getAttribute('aria-label') || '').includes('Organizer'))`),
    await bb.js(`[...document.querySelectorAll('.pitch-spot')]
      .map(s => s.getAttribute('aria-label')).filter(Boolean).join('|')`));

  await bb.shoot('20-live-updated');

  console.log('\nA withdraws');
  const beforeLeave = await playing(bb);
  await a.js(pressMine);
  await sleep(400);
  await a.js(pressMine);

  let afterLeave = beforeLeave;
  const t2 = Date.now();
  while (Date.now() - t2 < 6000) {
    afterLeave = await playing(bb);
    if (afterLeave !== beforeLeave) break;
    await sleep(250);
  }
  check('B saw the withdrawal live', afterLeave === beforeLeave - 1, `before=${beforeLeave} after=${afterLeave}`);
  console.log(`         (propagated in ${Date.now() - t2}ms)`);

  clearTestMembers();

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  killAll();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('crashed:', e);
  try { clearTestMembers(); } catch {}
  killAll();
  process.exit(1);
});
