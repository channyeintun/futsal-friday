/** Payments flow, driven over CDP. Assumes `wrangler dev` + `vite` are up. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localClaimPath, localOrganizerId } from './helpers.mjs';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;
const OUT_DIR = process.env.SHOTS_DIR ?? '/tmp/ff-shots';
// Point at a deployment with APP_URL; defaults to local dev.
const APP_URL = (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');

const profile = mkdtempSync(join(tmpdir(), 'ff-chrome-pay-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;
const results = [];
const check = (label, ok, detail) => {
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `\n         ${detail}`}`);
};

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) events.push(m);
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, events, ready };
}

async function run() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {}
    await sleep(200);
  }

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const { send, events, ready } = connect(target.webSocketDebuggerUrl);
  await ready;
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  // Pin the device locale: these suites assert English strings, and a device
  // choice outranks the member's stored preference.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('futsal:locale', 'en'); } catch {}`,
  });

  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const shoot = async (n) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT_DIR, `${n}.png`), Buffer.from(data, 'base64'));
  };
  const waitFor = async (expr, label, ms = 12000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(150); }
    check(label, false, `timeout: ${expr}`);
    return false;
  };

  console.log('\nsigning in');
  await send('Page.navigate', { url: `${APP_URL}${localClaimPath(localOrganizerId())}` });
  await waitFor('!!document.querySelector(".bottom-nav")', 'shell');
  await sleep(1500);

  console.log('\nopening a settled session');
  const opened = await js(`(() => {
    const rows = [...document.querySelectorAll('button.player-row')];
    const row = rows.find(r => /\\d{3}\\.\\d{3}d/.test(r.textContent));
    if (row) { row.click(); return row.textContent.trim(); }
    return null;
  })()`);
  check('found a settled session in history', !!opened, String(opened));
  await sleep(1500);
  await shoot('10-session-detail');

  const wentToPayments = await js(`(() => {
    const b = [...document.querySelectorAll('md-outlined-button')].find(x => x.textContent.includes('Payments'));
    if (b) { b.click(); return true; } return false;
  })()`);
  check('payments button present', wentToPayments);
  await waitFor('document.body.innerText.includes("Field total")', 'payments screen loads');
  await sleep(900);
  await shoot('11-payments');

  const text = await js('document.body.innerText');
  check('shows the field total', /Field total/.test(text), text.slice(0, 300));
  check('shows collected', /Collected/.test(text));
  check('shows outstanding', /Still owed/.test(text));
  check('lists everyone', /Everyone \(\d+\)/.test(text), text.match(/Everyone \(\d+\)/)?.[0]);
  check('has paid/unpaid badges', await js(`document.querySelectorAll('.badge').length > 0`));
  check('organizer sees confirm controls', /Confirm|Amount/.test(text));
  check('has a copy-status button', /Copy status for chat/.test(text));

  console.log('\nunsettled session shows the split form');
  await js(`[...document.querySelectorAll('.bottom-nav button')][0].click()`);
  await sleep(1200);
  const openedUnsplit = await js(`(() => {
    const rows = [...document.querySelectorAll('button.player-row')];
    const row = rows.find(r => r.textContent.includes('not split'));
    if (row) { row.click(); return true; } return false;
  })()`);
  if (openedUnsplit) {
    await sleep(1400);
    const toPay = await js(`(() => {
      const b=[...document.querySelectorAll('md-outlined-button')].find(x=>x.textContent.includes('Split the bill'));
      if (b) { b.click(); return true; } return false; })()`);
    check('offers to split an unsettled session', toPay);
    if (toPay) {
      // Material renders labels and supporting text inside a shadow root, so
      // `innerText` cannot see them — read the element's own properties.
      await waitFor(
        `document.querySelector('md-outlined-text-field')?.label === 'Total field charge'`,
        'split form loads',
      );
      await sleep(700);
      await shoot('12-split');
      check('split form explains the rounding',
        await js(`document.body.innerText.includes('nearest 1.000')`));
      // Type an amount and confirm the live formatting hint.
      await js(`(() => { const f=document.querySelector('md-outlined-text-field'); f.value='560k';
        f.dispatchEvent(new Event('input',{bubbles:true,composed:true})); })()`);
      await sleep(500);
      const hint = await js(`document.querySelector('md-outlined-text-field')?.supportingText ?? ''`);
      check('parses shorthand like 560k into 560.000d', hint === '560.000d', hint);
      await shoot('13-split-typed');
    }
  }

  const errors = events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.params.entry?.text ?? e.params.exceptionDetails?.exception?.description ?? '')
    .filter((t) => t && !t.includes('favicon') && !/401/.test(t));
  check('no console errors', errors.length === 0, errors.slice(0, 4).join('\n         '));

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  chrome.kill();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error('crashed:', e); chrome.kill(); process.exit(1); });
