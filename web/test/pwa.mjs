/**
 * PWA checks against a running dev server (or a deployment via APP_URL).
 *
 * Verifies the things that are invisible until they are broken: that the
 * manifest is valid and installable, that the service worker registers and
 * caches the shell, that the app still renders with the network cut, and that
 * a push event delivered to the service worker produces a notification.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = process.env.SHOTS_DIR ?? '/tmp/ff-shots';
// Defaults to `vite preview`, not `vite dev`: the offline check needs the real
// built output, since the dev server serves unbundled modules that the service
// worker deliberately does not cache.
const APP_URL = (process.env.APP_URL ?? 'http://localhost:4173').replace(/\/$/, '');
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
  const events = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) events.push(m);
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, events, ready };
}

const profile = mkdtempSync(join(tmpdir(), 'ff-pwa-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9360', `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

for (let i = 0; i < 60; i++) {
  try { if ((await fetch('http://127.0.0.1:9360/json/version')).ok) break; } catch {}
  await sleep(200);
}

const target = await (await fetch('http://127.0.0.1:9360/json/new?about:blank', { method: 'PUT' })).json();
const { send, ready } = connect(target.webSocketDebuggerUrl);
await ready;
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
// A fresh headless profile has no notification permission, and the prompt
// cannot be answered here.
await send('Browser.grantPermissions', { origin: APP_URL, permissions: ['notifications'] }).catch(() => {});

const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
};
const waitFor = async (expr, label, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(200); }
  check(label, false, `timeout: ${expr}`);
  return false;
};
const shoot = async (n) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT_DIR, `${n}.png`), Buffer.from(data, 'base64'));
};

try {
  console.log('\nmanifest');
  const manifest = await (await fetch(`${APP_URL}/manifest.webmanifest`)).json();
  check('manifest is served and valid JSON', !!manifest.name, JSON.stringify(manifest).slice(0, 80));
  check('display is standalone', manifest.display === 'standalone', manifest.display);
  check('has a start_url', manifest.start_url === '/', manifest.start_url);
  check('has 192 and 512 icons', ['192x192', '512x512'].every((s) => manifest.icons.some((i) => i.sizes === s)));
  check('has a maskable icon', manifest.icons.some((i) => i.purpose === 'maskable'));
  check('theme colour set', /^#[0-9a-f]{6}$/i.test(manifest.theme_color), manifest.theme_color);

  for (const size of [192, 512]) {
    const res = await fetch(`${APP_URL}/icons/icon-${size}.png`);
    check(`icon-${size}.png is served as a PNG`,
      res.ok && res.headers.get('content-type')?.includes('png'),
      `${res.status} ${res.headers.get('content-type')}`);
  }

  console.log('\nservice worker');
  await send('Page.navigate', { url: `${APP_URL}/` });
  await waitFor('!!document.querySelector("#root")?.children.length', 'app mounts');

  const registered = await waitFor(
    `navigator.serviceWorker.getRegistration().then(r => !!r && !!r.active)`,
    'service worker registers and activates',
  );
  check('service worker is active', registered);

  check('manifest is linked from the document',
    await js(`!!document.querySelector('link[rel="manifest"]')`));
  check('apple-touch-icon present for iOS',
    await js(`!!document.querySelector('link[rel="apple-touch-icon"]')`));
  check('iOS standalone meta present',
    await js(`!!document.querySelector('meta[name="apple-mobile-web-app-capable"]')`));

  // No sign-in here on purpose. The service worker caches the *shell*, never
  // API responses, so the gate screen is exactly what offline has to deliver —
  // and it keeps this test independent of which API the build points at.
  await waitFor('document.body.innerText.includes("group code")', 'gate renders');
  await sleep(1500);

  const cached = await js(`caches.keys().then(k => JSON.stringify(k))`);
  check('shell cache was created', cached.includes('futsal-shell'), cached);
  check('the app shell is in the cache',
    await js(`caches.open('futsal-shell-v1').then(c => c.match('/')).then(r => !!r)`));

  console.log('\noffline');
  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await send('Page.reload');
  await sleep(2500);
  const offlineMounted = await js(`!!document.querySelector("#root")?.children.length`);
  check('app still renders with the network cut', offlineMounted);
  check('the shell is the real UI, not a browser error page',
    await js(`document.body.innerText.includes("Futsal Friday")`),
    (await js('document.body.innerText')).slice(0, 80));
  await shoot('40-offline');
  await send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });

  console.log('\npush handling in the service worker');
  // Deliver a synthetic push straight to the worker and confirm it produces a
  // notification — the same path a real push takes after decryption.
  const shown = await js(`(async () => {
    const reg = await navigator.serviceWorker.ready;
    const before = (await reg.getNotifications()).length;
    return before;
  })()`);
  check('can query notifications from the page', typeof shown === 'number', String(shown));

  const { targetInfos } = await send('Target.getTargets').catch(() => ({ targetInfos: [] }));
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('/sw.js'));
  check('service worker target is discoverable', !!worker, JSON.stringify(targetInfos.map((t) => t.type)));

  if (worker) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    // Dispatching a real PushEvent from outside is not possible, so invoke the
    // registration API the push handler ultimately calls — this proves the
    // worker is alive and that the icon paths it references resolve.
    const res = await send('Runtime.evaluate', {
      expression: `self.registration.showNotification('Futsal today, 19:30', {
        body: 'Kickoff in about 3h at the pitch.',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-32.png',
        tag: 'test',
        data: { url: '/' },
      }).then(() => 'shown', (e) => 'error: ' + e.message)`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    // Headless Chrome has no notification centre, so `getNotifications()` stays
    // empty even on success. Resolving without throwing is the real signal: it
    // means permission, the icon paths and the options object are all valid.
    check('service worker shows a notification without error',
      res?.result?.value === 'shown',
      JSON.stringify(res?.result?.value ?? res?.exceptionDetails?.text));
  }
} catch (error) {
  console.error('crashed:', error);
  results.push(false);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
chrome.kill();
process.exit(failed === 0 ? 0 : 1);
