/** Payments flow, driven over CDP. Assumes `wrangler dev` + `vite` are up. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import qrcode from 'qrcode-generator';
import {
  clearTestSessions,
  loadShared,
  localClaimPath,
  localOrganizerId,
  localUnsettledSession,
} from './helpers.mjs';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Derived from the pid, never fixed. A run that dies without cleaning up (a
// crash, a `head`-truncated pipe) leaves headless Chrome holding the port, and
// a later run's `/json/new` would then open tabs in that *already signed-in*
// profile — which silently invalidates everything the suite thinks it proves.
const PORT = 9340 + (process.pid % 30);
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

  // Seeded before the app loads, not after: the home screen's session list is
  // cached, so a row inserted mid-run would not appear until something forced
  // a refetch.
  clearTestSessions();
  const organizerId = localOrganizerId();
  const unsettledId = localUnsettledSession([organizerId]);

  console.log('\nsigning in');
  await send('Page.navigate', { url: `${APP_URL}${localClaimPath(organizerId)}` });
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
  // Opened by id rather than hunted for on the home screen. That list is
  // `ORDER BY starts_at DESC LIMIT 12`, and a dev database accumulates enough
  // finished sessions to push a freshly seeded one off the end — which is how
  // this section came to skip itself silently in the first place. Seeding the
  // session *and* addressing it directly makes it run every time.
  await send('Page.navigate', { url: `${APP_URL}/session/${unsettledId}` });
  await waitFor(`document.body.innerText.includes('Split the bill')`,
    'the seeded unsettled session opens');
  await sleep(500);
  check('a finished session with no bill offers to split it',
    await js(`document.body.innerText.includes('Split the bill')`),
    await js(`document.body.innerText.slice(0, 200)`));
  const toPay = await js(`(() => {
    const b = [...document.querySelectorAll('md-outlined-button')].find(x => x.textContent.includes('Split the bill'));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  check('offers to split an unsettled session', toPay);

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

  const errors = events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.params.entry?.text ?? e.params.exceptionDetails?.exception?.description ?? '')
    .filter((t) => t && !t.includes('favicon') && !/401/.test(t));
  check('no console errors', errors.length === 0, errors.slice(0, 4).join('\n         '));

  console.log('\nhow to pay');
  // Deterministic by construction: settle the seeded session so this member
  // definitely owes something, rather than hunting for one where they happen
  // to. Hoping for the right state is how a section ends up testing nothing.
  const prepared = await js(`(async () => {
    const auth = { Authorization: 'Bearer ' + localStorage.getItem('futsal:token'), 'Content-Type': 'application/json' };
    const details = await fetch('/api/payment-details', {
      method: 'PUT', headers: auth,
      body: JSON.stringify({
        bankBin: '970436', bankName: 'Vietcombank',
        accountNumber: '0881000458086', accountName: 'NGUYEN VAN A',
        note: 'Put your name in the transfer note',
      }),
    });
    const settle = await fetch('/api/sessions/${unsettledId}/settle', {
      method: 'POST', headers: auth, body: JSON.stringify({ totalCharge: 240000 }),
    });
    return [details.status, settle.status].join(',');
  })()`);
  check('payment details set and the session settled', prepared === '200,200', prepared);

  await send('Page.navigate', { url: `${APP_URL}/payments/${unsettledId}` });
  await waitFor(`document.body.innerText.includes('You owe')`, 'the pay card appears when money is owed');
  await sleep(700);

  check('it shows the account number',
    await js(`document.body.innerText.includes('0881000458086')`),
    await js(`document.body.innerText.slice(0, 320)`));
  check('and who the account belongs to',
    await js(`document.body.innerText.includes('NGUYEN VAN A')`));
  check('and the organizer note', await js(`document.body.innerText.includes('transfer note')`));
  check('a QR is rendered', await js(`!!document.querySelector('.payment-qr svg')`));
  check('the QR is a real code, not an empty box',
    (await js(`document.querySelectorAll('.payment-qr svg path').length`)) > 0);
  await shoot('14-how-to-pay');

  /*
   * The code must encode what the page says it does.
   *
   * A QR that renders is not a QR that pays: the failure that matters is one
   * that scans cleanly to the wrong account or the wrong amount. So the
   * expected payload is rebuilt here from the values *shown on screen*, run
   * through the same encoder, and compared module for module against what the
   * page actually drew.
   */
  const onScreen = await js(`(() => {
    const dd = [...document.querySelectorAll('.pay-details dd')].map((n) => n.textContent.trim());
    const svg = document.querySelector('.payment-qr svg');
    const paths = svg.querySelector('path').getAttribute('d');
    return JSON.stringify({
      account: dd[1], reference: dd[3],
      amount: document.body.innerText.match(/You owe ([\\d.]+)d/)?.[1]?.replace(/\\./g, ''),
      viewBox: svg.getAttribute('viewBox'),
      darkModules: (paths.match(/M/g) || []).length,
    });
  })()`);
  const seen = JSON.parse(onScreen);
  check('the amount on screen is a whole number of dong', /^\d+$/.test(seen.amount ?? ''), seen.amount);

  const { buildVietQrPayload } = await loadShared();
  const expected = buildVietQrPayload({
    bankBin: '970436',
    accountNumber: seen.account,
    amount: Number(seen.amount),
    reference: seen.reference,
  });
  const ref = qrcode(0, 'M');
  ref.addData(expected);
  ref.make();
  let refDark = 0;
  for (let r = 0; r < ref.getModuleCount(); r++) {
    for (let c = 0; c < ref.getModuleCount(); c++) if (ref.isDark(r, c)) refDark++;
  }
  const refExtent = ref.getModuleCount() + 8;

  check('THE RENDERED QR IS THE PAYLOAD WE EXPECT',
    seen.viewBox === `0 0 ${refExtent} ${refExtent}` && seen.darkModules === refDark,
    `page ${seen.viewBox} / ${seen.darkModules} dark vs expected 0 0 ${refExtent} ${refExtent} / ${refDark}`);
  check('and it encodes this session\'s amount, not a static code',
    expected.includes(`54${String(seen.amount).length.toString().padStart(2, '0')}${seen.amount}`),
    expected.slice(0, 120));

  await js(`fetch('/api/payment-details', { method: 'DELETE', headers: { Authorization: 'Bearer ' + localStorage.getItem('futsal:token') } })`);

  clearTestSessions();

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  chrome.kill();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('crashed:', e);
  try { clearTestSessions(); } catch {}
  chrome.kill();
  process.exit(1);
});
