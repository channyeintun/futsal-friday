/**
 * Drives headless Chrome over CDP against the running dev server.
 * No dependencies — Node 24 has a global WebSocket.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const OUT_DIR = process.env.SHOTS_DIR ?? '/tmp/ff-shots';
// Point at a deployment with APP_URL / INVITE_CODE; defaults to local dev.
const APP_URL = (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const INVITE_CODE = process.env.INVITE_CODE ?? 'futsal-dev';

const profile = mkdtempSync(join(tmpdir(), 'ff-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForChrome() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

let nextId = 1;
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, events, ready };
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `\n         ${detail}`}`);
}

async function run() {
  await waitForChrome();

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const { send, events, ready } = connect(target.webSocketDebuggerUrl);
  await ready;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  // iPhone 14-ish viewport: this app lives inside a chat webview on a phone.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  };

  const shoot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
  };

  const waitFor = async (expression, label, timeout = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evalJs(expression)) return true;
      await sleep(150);
    }
    check(label, false, `timed out waiting for: ${expression}`);
    return false;
  };

  console.log('\nloading the app');
  await send('Page.navigate', { url: `${APP_URL}/` });
  await waitFor('!!document.querySelector("#root")?.children.length', 'app mounts');
  await sleep(600);

  check('gate screen renders', await evalJs('document.body.innerText.includes("Futsal Friday")'));
  check('asks for the invite code', await evalJs('document.body.innerText.includes("group code")'), await evalJs('document.body.innerText.slice(0,200)'));
  await shoot('01-gate');

  console.log('\nwrong code is refused');
  await evalJs(`(() => {
    const f = document.querySelector('md-outlined-text-field');
    f.value = 'nope';
    f.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  })()`);
  await sleep(200);
  await evalJs(`document.querySelector('md-filled-button').click()`);
  await waitFor('document.body.innerText.includes("not right")', 'wrong code shows an error');
  await shoot('02-bad-code');

  console.log('\ncorrect code opens the name picker');
  await evalJs(`(() => {
    const f = document.querySelector('md-outlined-text-field');
    f.value = ${JSON.stringify(INVITE_CODE)};
    f.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  })()`);
  await sleep(250);
  await evalJs(`document.querySelector('md-filled-button').click()`);
  const gotNames = await waitFor('document.body.innerText.includes("Which one are you")', 'name picker appears');
  await shoot('03-pick-name');

  if (gotNames) {
    const names = await evalJs(`[...document.querySelectorAll('md-outlined-button')].map(b => b.textContent.trim())`);
    check('lists the roster', Array.isArray(names) && names.length > 1, JSON.stringify(names));
    check('marks the organizer', names.some((n) => n.includes('organizer')), JSON.stringify(names));

    console.log('\nsigning in as the organizer');
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('md-outlined-button')].find(x => x.textContent.includes('organizer'));
      b.click();
    })()`);
  }

  await waitFor('!!document.querySelector(".bottom-nav")', 'app shell renders after sign-in', 12000);
  await sleep(1200);
  await shoot('04-home');

  check('shows the upcoming session', await evalJs('document.body.innerText.includes("Playing")'), await evalJs('document.body.innerText.slice(0,400)'));
  check('has a register button', await evalJs(`document.body.innerText.includes("I'm in") || document.body.innerText.includes("Can't make it")`));
  check('shows a connection indicator', await evalJs('!!document.querySelector(".conn")'));
  // Either state is correct: `live` when Upstash is configured, `polling` when
  // it is not. What matters is that the connection resolves to one of them
  // rather than getting stuck.
  check('connection settles into live or polling',
    await waitFor(
      `['live','polling'].some(s => document.querySelector('.conn')?.className.includes(s))`,
      'connection settles',
    ),
    await evalJs(`document.querySelector('.conn')?.className`));

  console.log('\nregistering');
  // The dev database persists between runs, so normalise to "not registered"
  // first and then assert the round trip in both directions.
  const clickByText = async (text) => evalJs(`(() => {
    const b = [...document.querySelectorAll('md-filled-button, md-outlined-button')]
      .find(x => x.textContent.includes(${JSON.stringify(text)}));
    if (b) { b.click(); return true; }
    return false;
  })()`);

  const playing = () => evalJs('Number(document.body.innerText.match(/Playing (\\d+)/)?.[1] ?? -1)');

  if (await evalJs(`!!document.querySelector('.player-row.is-me')`)) {
    await clickByText("Can't make it") || await clickByText('Leave the waitlist');
    await sleep(1500);
  }
  check('starts not registered', !(await evalJs(`!!document.querySelector('.player-row.is-me')`)));

  const before = await playing();
  check('clicked join', await clickByText("I'm in"));
  await sleep(1600);
  const after = await playing();
  check('registering increases the count', after === before + 1, `before=${before} after=${after}`);
  check('shows me in the list', await evalJs(`!!document.querySelector('.player-row.is-me')`));
  check('toast confirms', await evalJs(`!!document.querySelector('.snackbar')`));
  await shoot('05-registered');

  console.log('\nwithdrawing');
  check('clicked withdraw', await clickByText("Can't make it"));
  await sleep(1600);
  const afterLeave = await playing();
  check('withdrawing decreases the count', afterLeave === before, `expected ${before}, got ${afterLeave}`);
  check('no longer in the list', !(await evalJs(`!!document.querySelector('.player-row.is-me')`)));

  // Put them back so the payments section below has a player to bill.
  await clickByText("I'm in");
  await sleep(1200);

  console.log('\ncopy summary');
  const summary = await evalJs(`(() => {
    // Read the text the copy button would put on the clipboard.
    const btns = [...document.querySelectorAll('md-filled-tonal-button')];
    return btns.map(b => b.textContent.trim()).join('|');
  })()`);
  check('copy button present', typeof summary === 'string' && summary.includes('Copy list'), summary);

  console.log('\nnavigation');
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')][1].click()`);
  await waitFor('document.body.innerText.includes("sessions played")', 'history screen loads');
  await shoot('06-history');
  check('history shows my name', await evalJs(`document.body.innerText.includes('Organizer')`));

  await evalJs(`[...document.querySelectorAll('.bottom-nav button')][2].click()`);
  await waitFor('document.body.innerText.includes("Players")', 'admin screen loads');
  await sleep(500);
  await shoot('07-admin');
  check('admin lists venues', await evalJs('document.body.innerText.includes("Venues")'));
  check('admin offers extra session', await evalJs('document.body.innerText.includes("Extra session")'));

  console.log('\ndark mode');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')][0].click()`);
  await sleep(1200);
  await shoot('08-dark');
  const bg = await evalJs(`getComputedStyle(document.body).backgroundColor`);
  check('dark theme applies', bg === 'rgb(18, 20, 15)', bg);

  // Console errors, excluding noise we do not control.
  const errors = events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.params.entry?.text ?? e.params.exceptionDetails?.exception?.description ?? '')
    .filter((t) => t && !t.includes('favicon'))
    // The app probes /auth/me on boot to recover a cookie-only session; a 401
    // there is the expected answer for a signed-out visitor, not a fault.
    .filter((t) => !/401/.test(t));
  check('no console errors', errors.length === 0, errors.slice(0, 5).join('\n         '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  chrome.kill();
  process.exit(failed.length === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('UI test crashed:', e);
  chrome.kill();
  process.exit(1);
});
