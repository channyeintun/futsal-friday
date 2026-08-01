/**
 * Drives headless Chrome over CDP against the running dev server.
 * No dependencies — Node 24 has a global WebSocket.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localClaimPath, localOrganizerId } from './helpers.mjs';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Derived from the pid, never fixed. A run that dies without cleaning up (a
// crash, a `head`-truncated pipe) leaves headless Chrome holding the port, and
// a later run's `/json/new` would then open tabs in that *already signed-in*
// profile — which silently invalidates everything the suite thinks it proves.
const PORT = 9300 + (process.pid % 30);
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
  // These suites assert English strings, so pin the device's locale choice
  // before the app boots. A device choice outranks the member's stored
  // preference, which is exactly the precedence the app documents.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('futsal:locale', 'en'); } catch {}`,
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

  console.log('\nwithout a link');
  await send('Page.navigate', { url: `${APP_URL}/` });
  await waitFor('!!document.querySelector("#root")?.children.length', 'app mounts');
  await sleep(600);

  check('shows the app name', await evalJs('document.body.innerText.includes("Futsal Friday")'));
  check('explains that a link is needed',
    await evalJs('document.body.innerText.includes("personal link")'),
    await evalJs('document.body.innerText.slice(0,200)'));
  check('does not reveal who is in the group',
    await evalJs(`document.querySelectorAll('md-outlined-button').length <= 2`),
    await evalJs(`[...document.querySelectorAll('md-outlined-button')].map(b=>b.textContent.trim()).join('|')`));
  await shoot('01-needs-link');

  console.log('\na bad link is refused');
  await send('Page.navigate', { url: `${APP_URL}/claim#${'z'.repeat(43)}` });
  await waitFor('document.body.innerText.includes("not valid any more")', 'bad link shows an error');
  await shoot('02-bad-link');

  console.log('\nsigning in with a claim link');
  // Cold load, which is what tapping a link in a chat app actually does.
  await send('Page.navigate', { url: 'about:blank' });
  await send('Page.navigate', { url: `${APP_URL}${localClaimPath(localOrganizerId())}` });

  await waitFor('!!document.querySelector(".bottom-nav")', 'app shell renders after sign-in', 12000);
  check('the secret is stripped from the address bar',
    await evalJs('location.hash === ""'), await evalJs('location.hash'));
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
  // The profile card replaced the old plain header, so this now waits on the
  // streak rather than the sentence it used to print.
  await waitFor('!!document.querySelector(".streak-cell")', 'history screen loads');
  await shoot('06-history');
  check('history shows my name', await evalJs(`document.body.innerText.includes('Organizer')`));

  await evalJs(`[...document.querySelectorAll('.bottom-nav button')][2].click()`);
  await waitFor('document.body.innerText.includes("Players")', 'admin screen loads');
  await sleep(500);
  await shoot('07-admin');
  check('admin lists venues', await evalJs('document.body.innerText.includes("Venues")'));
  check('admin offers extra session', await evalJs('document.body.innerText.includes("Extra session")'));

  console.log('\nthe group invite card');
  check('the group link card is on the setup screen',
    await evalJs('document.body.innerText.includes("Group invite link")'));
  // One button either way — create it if there is none, then it must show the
  // real URL, because that is the thing the organizer pastes into the chat.
  const hadLink = await evalJs('/\\/join#/.test(document.body.innerText)');
  if (!hadLink) {
    await clickByText('Create group link');
    await waitFor('/\\/join#/.test(document.body.innerText)', 'creating the group link shows it');
  }
  check('the link points at /join', await evalJs(`/\\/join#[A-Za-z0-9_-]{40,}/.test(document.body.innerText)`),
    await evalJs(`document.body.innerText.match(/http\\S*join\\S*/)?.[0]`));
  check('it says how many are still to join',
    await evalJs('/still to join|Everyone has joined/.test(document.body.innerText)'),
    await evalJs('document.body.innerText.slice(0, 400)'));
  check('it warns what replacing the link does',
    await evalJs('document.body.innerText.includes("already in the chat from working")'),
    await evalJs('document.body.innerText.slice(0, 500)'));
  // Scroll it into view: a screenshot of a card below the fold proves nothing.
  await evalJs(`[...document.querySelectorAll('.card-title')]
    .find(h => h.textContent.includes('Group invite link'))
    ?.closest('.card').scrollIntoView({ block: 'center' })`);
  await sleep(400);
  await shoot('09-group-link');

  console.log('\nprofile and streak');
  // The dev database persists between runs, and a previous run leaves a
  // picture behind. Start from "no picture" so the fallback is actually being
  // tested rather than whatever the last run happened to leave.
  await evalJs(`fetch('/api/members/me/avatar', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + localStorage.getItem('futsal:token') },
  }).then((r) => r.status)`);
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')][1].click()`);
  await send('Page.reload');
  await waitFor('document.body.innerText.includes("Streak")', 'the profile card leads History');
  await sleep(500);
  await shoot('11-profile');
  check('it shows a current streak', await evalJs(`document.querySelectorAll('.streak-cell').length === 3`),
    await evalJs(`document.querySelectorAll('.streak-cell').length`));
  check('the streak values are numbers',
    await evalJs(`[...document.querySelectorAll('.streak-value')].every(v => /^\\d+$/.test(v.textContent.trim()))`),
    await evalJs(`[...document.querySelectorAll('.streak-value')].map(v => v.textContent.trim()).join(',')`));
  check('it counts matches played of total',
    await evalJs(`/Played \\d+ of \\d+ matches/.test(document.body.innerText)`),
    await evalJs(`document.body.innerText.slice(0, 200)`));
  check('with no picture it falls back to initials',
    await evalJs(`(() => { const a = document.querySelector('.avatar'); return !a.querySelector('img') && a.textContent.trim().length > 0; })()`),
    await evalJs(`document.querySelector('.avatar')?.textContent`));
  check('and offers to change the picture',
    await evalJs(`!!document.querySelector('.avatar-edit')`));

  // The file picker cannot be driven headlessly, so the upload goes through
  // the same endpoint the button calls, from the page's own origin and
  // credentials. What is being proved here is the *render* path: that a real
  // stored picture comes back down and replaces the initials.
  const uploaded = await evalJs(`(async () => {
    const png = Uint8Array.from(atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR42mP8z/C/noEIwDiqkL4KAcLIDAWkFyKrAAAAAElFTkSuQmCC'
    ), (c) => c.charCodeAt(0));
    const res = await fetch('/api/members/me/avatar', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + localStorage.getItem('futsal:token'),
        'Content-Type': 'image/png',
      },
      body: png,
    });
    return res.status;
  })()`);
  check('a picture can be stored', uploaded === 200, uploaded);

  await send('Page.reload');
  await waitFor('!!document.querySelector(".streak-cell")', 'history reloads with a picture');
  await waitFor('!!document.querySelector(".avatar img")', 'the stored picture renders');
  check('the initials are gone once there is a photo',
    await evalJs(`document.querySelector('.avatar').textContent.trim() === ''`),
    await evalJs(`document.querySelector('.avatar').textContent`));
  await sleep(400);
  await shoot('13-avatar');

  // And it reaches the places that list people, not just the profile.
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')][2].click()`);
  await waitFor('document.body.innerText.includes("Players")', 'roster loads');
  await sleep(600);
  check('the roster shows the picture too',
    await evalJs(`!!document.querySelector('.member-row .avatar img')`),
    await evalJs(`document.querySelectorAll('.member-row .avatar').length`));

  await evalJs(`[...document.querySelectorAll('.bottom-nav button')][1].click()`);
  await waitFor('!!document.querySelector(".streak-cell")', 'back on history');
  await sleep(300);

  // A team-mate's profile is reachable from the session list.
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')][0].click()`);
  await waitFor('!!document.querySelector(".conn")', 'back on the session screen');
  await sleep(500);
  const openedProfile = await evalJs(`(() => {
    const b = document.querySelector('.player-name.link');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('a name on the list opens a profile', openedProfile);
  if (openedProfile) {
    await waitFor('location.pathname.startsWith("/profile/")', 'it navigates to /profile/:id');
    await waitFor('!!document.querySelector(".streak-cell")', 'their streak renders');
    await sleep(400);
    await shoot('12-profile-other');
    check('a team-mate\'s profile hides their money',
      !(await evalJs('document.body.innerText.includes("You owe")')));
  }
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')][0].click()`);
  await waitFor('!!document.querySelector(".conn")', 'back to the session again');
  await sleep(400);

  console.log('\nthe random announcement');
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')][0].click()`);
  await waitFor('!!document.querySelector(".conn")', 'back on the session screen');
  await sleep(600);
  const openAnnounce = `(() => {
    const b = [...document.querySelectorAll('md-text-button')].find(x => x.textContent.includes('Write an announcement'));
    if (b) { b.click(); return true; }
    return false;
  })()`;
  check('the session screen offers an announcement', await evalJs(openAnnounce));
  await waitFor('document.body.innerText.includes("Hype the group")', 'the announcement dialog opens');
  await sleep(400);

  const announced = () => evalJs(`document.querySelector('md-dialog[open] .summary-preview')?.textContent ?? ''`);
  const first = await announced();
  check('it carries the real kickoff time', first.includes('19:30'), first.slice(0, 200));
  check('it carries the venue', /Pitch/.test(first), first.slice(0, 200));
  check('and a link back to the app', first.includes('http'), first.slice(0, 200));
  await shoot('10-announce');

  // Shuffling must actually produce something else, not redraw the same text.
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('md-dialog[open] md-text-button')]
      .find(x => x.textContent.includes('Another one'));
    b.click();
  })()`);
  await sleep(400);
  check('shuffling writes a different one', (await announced()) !== first,
    (await announced()).slice(0, 120));

  await evalJs(`document.querySelector('md-dialog[open]')?.close()`);
  await sleep(400);

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
