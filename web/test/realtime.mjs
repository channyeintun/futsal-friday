/**
 * Two independent browsers on the same session page. One registers; the other
 * must update with no reload and no poll (the poll interval is 30s, so any
 * change inside a few seconds can only have come over SSE).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = process.env.SHOTS_DIR ?? '/tmp/ff-shots';
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

async function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), `ff-live-${port}-`));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await sleep(200);
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const { send, ready } = connect(target.webSocketDebuggerUrl);
  await ready;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

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

async function signIn(b, who) {
  await b.send('Page.navigate', { url: 'http://localhost:5173/' });
  await b.waitFor('document.body.innerText.includes("group code")', `${who}: gate renders`);
  await b.js(`(() => { const f=document.querySelector('md-outlined-text-field'); f.value='futsal-dev';
    f.dispatchEvent(new Event('input',{bubbles:true,composed:true})); })()`);
  await sleep(250);
  await b.js(`document.querySelector('md-filled-button').click()`);
  await b.waitFor('document.body.innerText.includes("Which one are you")', `${who}: picker`);
  const clicked = await b.js(`(() => {
    const btns = [...document.querySelectorAll('md-outlined-button')];
    const b = btns.find(x => x.textContent.includes(${JSON.stringify(who)}));
    if (b) { b.click(); return true; } return false;
  })()`);
  check(`${who}: signed in`, clicked);
  await b.waitFor('!!document.querySelector(".bottom-nav")', `${who}: shell`);
  await sleep(2500);
}

const playing = (b) => b.js('Number(document.body.innerText.match(/Playing (\\d+)/)?.[1] ?? -1)');
const connState = (b) => b.js(`document.querySelector('.conn')?.className ?? 'none'`);

async function run() {
  console.log('\nlaunching two browsers');
  const a = await launch(9401);
  const bb = await launch(9402);

  await signIn(a, 'Organizer');
  // Any non-organizer from the smoke-test roster.
  const aliceName = await a.js(`'Alice'`);
  await signIn(bb, aliceName);

  console.log('\nboth connect live');
  await a.waitFor(`document.querySelector('.conn')?.className.includes('live')`, 'A reaches live');
  await bb.waitFor(`document.querySelector('.conn')?.className.includes('live')`, 'B reaches live');
  check('A is live over SSE', (await connState(a)).includes('live'), await connState(a));
  check('B is live over SSE', (await connState(bb)).includes('live'), await connState(bb));

  // Normalise: make sure A is not registered.
  if (await a.js(`!!document.querySelector('.player-row.is-me')`)) {
    await a.js(`(() => { const b=[...document.querySelectorAll('md-outlined-button')]
      .find(x=>x.textContent.includes("Can't make it")||x.textContent.includes('Leave the waitlist')); if(b) b.click(); })()`);
    await sleep(2000);
  }

  const beforeB = await playing(bb);
  console.log(`\nB sees ${beforeB} playing; A registers now`);

  await a.js(`(() => { const b=[...document.querySelectorAll('md-filled-button')]
    .find(x=>x.textContent.includes("I'm in")); if(b) b.click(); })()`);

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
  check("B's list now contains the new player",
    await bb.js(`document.body.innerText.includes('Organizer')`));

  await bb.shoot('20-live-updated');

  console.log('\nA withdraws');
  const beforeLeave = await playing(bb);
  await a.js(`(() => { const b=[...document.querySelectorAll('md-outlined-button')]
    .find(x=>x.textContent.includes("Can't make it")); if(b) b.click(); })()`);

  let afterLeave = beforeLeave;
  const t2 = Date.now();
  while (Date.now() - t2 < 6000) {
    afterLeave = await playing(bb);
    if (afterLeave !== beforeLeave) break;
    await sleep(250);
  }
  check('B saw the withdrawal live', afterLeave === beforeLeave - 1, `before=${beforeLeave} after=${afterLeave}`);
  console.log(`         (propagated in ${Date.now() - t2}ms)`);

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  a.proc.kill(); bb.proc.kill();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error('crashed:', e); process.exit(1); });
