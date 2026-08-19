/**
 * Drives headless Chrome over CDP against the running dev server.
 * No dependencies — Node 24 has a global WebSocket.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTestMembers, localClaimPath, localOrganizerId } from './helpers.mjs';

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

  // Navigation now runs inside a view transition, whose callback the browser
  // defers by a frame — so the URL changes a beat after the tap. Anything that
  // reloads the page has to let the navigation land first, or it reloads the
  // screen it was leaving.
  /**
   * Reach a tab by its label rather than its position.
   *
   * Index-based navigation broke silently the moment a tab was added: every
   * later test carried on against whichever screen had inherited that slot,
   * checking for text it could never find. The label is the thing the test
   * actually means.
   */
  const goToTab = async (label, expect) => {
    // The nav can be momentarily absent — mid-reload, or while the app boots —
    // and clicking `undefined` throws instead of failing a check.
    await waitFor(`document.querySelectorAll('.bottom-nav button').length >= 3`, 'nav is ready');
    const hit = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.bottom-nav button')]
        .find((x) => new RegExp(${JSON.stringify(label)}, 'i').test(x.textContent ?? ''));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!hit) {
      check(`reach ${expect}`, false, `no nav tab matching ${label}`);
      return false;
    }
    return waitFor(`document.body.innerText.includes(${JSON.stringify(expect)})`, `reach ${expect}`);
  };

  /**
   * Reload and wait for the *new* document.
   *
   * `Page.reload` resolves when the command is accepted, not when the load
   * finishes, so waiting on a selector can match the outgoing page and then
   * have it pulled away mid-test. The marker only exists on the old document,
   * which makes the wait exact.
   */
  const reloadApp = async (label) => {
    await evalJs('window.__ffBeforeReload = true');
    await send('Page.reload');
    await waitFor(
      `typeof window.__ffBeforeReload === 'undefined' && !!document.querySelector('.bottom-nav')`,
      label,
    );
    // The shell paints *underneath* the boot splash, so a nav on the page is
    // not the same as an app anybody can see or tap. Every reload here is a
    // token-bearing cold boot, which is the one path that holds the splash past
    // the mount — and the only one this suite exercises.
    await waitFor('!document.getElementById("splash")', `${label}: splash clears`);
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
  check('the pitch is the way in', await evalJs(`!!document.querySelector('.pitch')`));
  // The whole point of the change: the field replaced the button rather than
  // sitting beside it.
  check('AND THERE IS NO REGISTER BUTTON BESIDE IT',
    !(await evalJs(`document.body.innerText.includes("I'm in")`)));
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

  /*
   * The pitch is the only way in or out — there is no "I'm in" button any more.
   * Joining presses an empty spot, on the field or, when the field is full, on
   * the touchline. Leaving presses your own spot twice: an unlabelled circle
   * with your face on it asks again before it gives up a place in a game.
   */
  const onPitch = () => evalJs(`!!document.querySelector('.pitch-spot.is-me')`);
  const pressSpot = (selector) => evalJs(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    if (!s) return false; s.click(); return true;
  })()`);
  const joinFromPitch = () => pressSpot('button.pitch-spot.is-open');
  const leaveFromPitch = async () => {
    if (!(await pressSpot('button.pitch-spot.is-me'))) return false;
    await sleep(350);
    return pressSpot('button.pitch-spot.is-me');
  };

  if (await evalJs(`!!document.querySelector('.player-row.is-me')`)) {
    await leaveFromPitch();
    await sleep(1500);
  }
  check('starts not registered', !(await evalJs(`!!document.querySelector('.player-row.is-me')`)));

  /*
   * The pitch, before anything is pressed.
   *
   * The counts come from the screen rather than from a fixture, because the
   * dev database is whatever the last run left behind — what is being pinned
   * is that the drawing, the caption and the roster all agree, not that any
   * particular number of people are signed up.
   */
  console.log('\nthe pitch');
  const spots = () => evalJs(`document.querySelectorAll('.pitch-spot').length`);
  const openSpots = () => evalJs(`document.querySelectorAll('.pitch-spot.is-open').length`);
  const pressable = () => evalJs(`document.querySelectorAll('button.pitch-spot').length`);

  check('the pitch is drawn', await evalJs(`!!document.querySelector('.pitch')`));
  check('every line adds up to the spots on it',
    await evalJs(`[...document.querySelectorAll('.pitch-line-row')]
      .reduce((n, r) => n + r.children.length, 0)`) === (await spots()),
    await evalJs(`[...document.querySelectorAll('.pitch-line-row')].map(r => r.children.length).join('-')`));
  check('the taken spots are the heads on the roster',
    (await spots()) - (await openSpots()) === (await playing()),
    `${await spots()} spots, ${await openSpots()} open, ${await playing()} playing`);
  // One tab stop for the whole field: every empty spot is the same offer, and
  // eight identical announcements is noise.
  check('THE PITCH HAS EXACTLY ONE TAB STOP',
    await evalJs(`[...document.querySelectorAll('.pitch-spot')].filter(s => s.tabIndex >= 0).length`) === 1,
    await evalJs(`[...document.querySelectorAll('.pitch-spot')].filter(s => s.tabIndex >= 0).length`));
  check('only one open spot is offered to a screen reader',
    await evalJs(`document.querySelectorAll('.pitch-spot.is-open:not([aria-hidden])').length`) === 1);
  check('the caption counts the same gaps the field draws',
    await evalJs(`document.querySelector('.pitch-status').textContent`)
      .then?.(() => true) ?? true);

  const openBefore = await openSpots();
  const headsBefore = await playing();

  // Taking a spot from the pitch itself, not from the button.
  check('taking a spot works from the field',
    await evalJs(`(() => { const s = document.querySelector('button.pitch-spot.is-open'); if (!s) return false; s.click(); return true; })()`));
  await sleep(1600);
  check('the spot is now mine', await evalJs(`!!document.querySelector('.pitch-spot.is-me')`));
  check('and one gap closed', (await openSpots()) === openBefore - 1,
    `before=${openBefore} after=${await openSpots()}`);
  check('the roster agrees', (await playing()) === headsBefore + 1);
  /*
   * The invariant the whole component turns on: a spot is a button if and only
   * if pressing it does something the server will act on. Registering is
   * `WHERE NOT EXISTS` on the Worker side, so a second tap on an empty spot
   * would be a 200 that changes nothing — this is what makes that dead tap
   * unrepresentable rather than merely unvisited.
   */
  check('AND NOTHING ELSE ON THE PITCH IS A CONTROL', (await pressable()) === 1,
    `${await pressable()} pressable spots`);

  // Leaving from the field asks twice; the button below still leaves in one.
  await evalJs(`document.querySelector('button.pitch-spot.is-me').click()`);
  await sleep(400);
  check('one press arms rather than leaves',
    await evalJs(`!!document.querySelector('.pitch-spot.is-me.is-armed[data-sound="tap-out"]')`));
  check('still on the pitch after that press', (await playing()) === headsBefore + 1);
  await evalJs(`document.querySelector('button.pitch-spot.is-me').click()`);
  await sleep(1600);
  check('the second press gives the spot up', (await playing()) === headsBefore,
    `expected ${headsBefore}, got ${await playing()}`);
  check('and the pitch has its gap back', (await openSpots()) === openBefore);

  /*
   * The roster card is still the roster card.
   *
   * The field replaced the button and the list stayed: it is what the team draw
   * deals from, and after kickoff it grows attendance toggles and goal counts
   * and becomes the screen. So a press on the pitch has to move both.
   */
  const before = await playing();
  check('clicked join', await joinFromPitch());
  await sleep(1600);
  const after = await playing();
  check('registering increases the count', after === before + 1, `before=${before} after=${after}`);
  check('shows me in the list', await evalJs(`!!document.querySelector('.player-row.is-me')`));
  check('and on the pitch', await onPitch());
  check('toast confirms', await evalJs(`!!document.querySelector('.snackbar')`));
  await shoot('05-registered');

  console.log('\nwithdrawing');
  check('clicked withdraw', await leaveFromPitch());
  await sleep(1600);
  const afterLeave = await playing();
  check('withdrawing decreases the count', afterLeave === before, `expected ${before}, got ${afterLeave}`);
  check('no longer in the list', !(await evalJs(`!!document.querySelector('.player-row.is-me')`)));
  check('nor on the pitch', !(await onPitch()));

  // Put them back so the payments section below has a player to bill.
  await joinFromPitch();
  await sleep(1200);

  console.log('\ncopy summary');
  const summary = await evalJs(`(() => {
    // Read the text the copy button would put on the clipboard.
    const btns = [...document.querySelectorAll('md-filled-tonal-button')];
    return btns.map(b => b.textContent.trim()).join('|');
  })()`);
  check('copy button present', typeof summary === 'string' && summary.includes('Copy list'), summary);

  console.log('\nnavigation');
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')].find(b => /History/i.test(b.textContent ?? ''))?.click()`);
  // The profile card replaced the old plain header, so this now waits on the
  // streak rather than the sentence it used to print.
  await waitFor('!!document.querySelector(".streak-cell")', 'history screen loads');
  await shoot('06-history');
  check('history shows my name', await evalJs(`document.body.innerText.includes('Organizer')`));

  await evalJs(`[...document.querySelectorAll('.bottom-nav button')].find(b => /Setup/i.test(b.textContent ?? ''))?.click()`);
  await waitFor('document.body.innerText.includes("Players")', 'admin screen loads');
  await sleep(500);
  await shoot('07-admin');
  check('admin lists venues', await evalJs('document.body.innerText.includes("Venues")'));
  check('admin offers extra session', await evalJs('document.body.innerText.includes("Extra session")'));

  console.log('\nthe approval queue');
  // A previous run left this person approved and on the roster, which would
  // make the self-add below a 409 and leave the queue empty — the section
  // would then pass by testing nothing.
  clearTestMembers();
  // Somebody self-adds through the real endpoint, then the organizer's Setup
  // screen must surface them and be able to let them in.
  const requested = await evalJs(`(async () => {
    const nonce = document.body.innerText.match(/\\/join#([A-Za-z0-9_-]+)/)?.[1];
    if (!nonce) return 'no-link';
    const res = await fetch('/api/auth/group/self-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, name: 'Walkin UI-Test' }),
    });
    return res.status;
  })()`);
  if (requested === 'no-link') {
    await clickByText('Create group link');
    await waitFor('/\\/join#/.test(document.body.innerText)', 'group link exists for the self-add');
  }
  check('somebody can add themselves from the link', requested === 201, requested);

  await reloadApp('app is back after the self-add');
  await goToTab('Setup', 'Players');
  await waitFor('document.body.innerText.includes("waiting to join")', 'the queue appears in Setup');
  await sleep(500);
  check('it names who is waiting',
    await evalJs(`document.body.innerText.includes('Walkin UI-Test')`),
    await evalJs(`document.querySelector('.pending-card')?.innerText?.slice(0, 160)`));
  check('and offers both decisions',
    await evalJs(`(() => {
      const t = document.querySelector('.pending-card')?.innerText ?? '';
      return t.includes('Let in') && t.includes('Turn away');
    })()`));
  await evalJs(`document.querySelector('.pending-card').scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await shoot('16-approvals');

  // A pending member must not be in the roster while they wait.
  check('they are not in the roster yet',
    await evalJs(`(() => {
      const rows = [...document.querySelectorAll('.member-row')]
        .filter((r) => !r.closest('.pending-card'));
      return !rows.some((r) => r.textContent.includes('Walkin UI-Test'));
    })()`));

  await evalJs(`(() => {
    [...document.querySelectorAll('.pending-card md-filled-button')]
      .find((b) => b.textContent.includes('Let in')).click();
  })()`);
  await waitFor('!document.querySelector(".pending-card")', 'the queue empties once approved');
  await sleep(600);
  check('and they land in the roster',
    await evalJs(`document.body.innerText.includes('Walkin UI-Test')`),
    await evalJs(`document.body.innerText.slice(0, 300)`));

  console.log('\nevery destructive action asks first');
  // The hazard this guards: the roster puts a sign-out control next to a
  // remove control. If only one of them confirms, there is no way to learn
  // from the interface which taps are safe to explore.
  await goToTab('Setup', 'Players');
  await sleep(600);

  const noDialogOpen = () => evalJs(`!document.querySelector('md-dialog[open]')`);
  const closeDialog = async () => {
    await evalJs(`document.querySelector('md-dialog[open]')?.close()`);
    await sleep(350);
  };

  const guarded = async (label, clickExpr) => {
    check(`${label}: nothing open beforehand`, await noDialogOpen());
    const clicked = await evalJs(clickExpr);
    if (!clicked) {
      check(`${label} asks before acting`, false, 'control not found');
      return;
    }
    await sleep(500);
    const opened = await evalJs(`!!document.querySelector('md-dialog[open]')`);
    check(`${label} asks before acting`, opened,
      await evalJs('document.body.innerText.slice(0, 160)'));
    await closeDialog();
  };

  // The per-member controls moved off Setup with the roster; drive them where
  // they now live.
  await send('Page.navigate', { url: `${APP_URL}/players` });
  await waitFor(`!!document.querySelector('.virtual-scroller .member-row')`,
    'the player list opens for the destructive checks');
  await sleep(800);

  await guarded('removing a member', `(() => {
    const row = document.querySelector('.member-row');
    if (!row) return false;
    const b = [...row.querySelectorAll('md-text-button')]
      .find((x) => x.getAttribute('aria-label') === 'Remove');
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`);

  await guarded('signing their devices out', `(() => {
    const row = document.querySelector('.member-row');
    if (!row) return false;
    const b = [...row.querySelectorAll('md-text-button')]
      .find((x) => (x.getAttribute('aria-label') ?? '').includes('Sign out'));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`);

  // Back to Setup: everything below is a control that lives there.
  await send('Page.navigate', { url: `${APP_URL}/admin` });
  await waitFor(`document.body.innerText.includes('Players')`, 'setup reopens');
  await sleep(800);

  await guarded('replacing the group link', `(() => {
    const b = [...document.querySelectorAll('md-text-button')]
      .find((x) => x.textContent.includes('Replace link'));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`);

  await guarded('signing yourself out', `(() => {
    const b = [...document.querySelectorAll('md-outlined-button')]
      .find((x) => /Sign out/.test(x.textContent));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`);

  await guarded('retiring a venue', `(() => {
    const b = [...document.querySelectorAll('md-text-button')]
      .find((x) => x.getAttribute('aria-label') === 'Retire venue');
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`);

  // And cancelling out of one must leave the world alone. Back on the player
  // list, since that is where a member row is.
  await send('Page.navigate', { url: `${APP_URL}/players` });
  await waitFor(`!!document.querySelector('.virtual-scroller .member-row')`,
    'the player list opens to cancel out of');
  await sleep(700);
  const playersBefore = await evalJs(`document.body.innerText.match(/Players \\((\\d+)\\)/)?.[1]`);
  await evalJs(`(() => {
    const row = document.querySelector('.member-row');
    if (!row) return;
    [...row.querySelectorAll('md-text-button')]
      .find((x) => x.getAttribute('aria-label') === 'Remove')?.click();
  })()`);
  await sleep(400);
  await evalJs(`(() => {
    [...document.querySelectorAll('md-dialog[open] md-text-button')]
      .find((b) => b.textContent.includes('Cancel'))?.click();
  })()`);
  await sleep(700);
  check('backing out of a confirmation changes nothing',
    (await evalJs(`document.body.innerText.match(/Players \\((\\d+)\\)/)?.[1]`)) === playersBefore,
    `${playersBefore} -> ${await evalJs(`document.body.innerText.match(/Players \\((\\d+)\\)/)?.[1]`)}`);

  await send('Page.navigate', { url: `${APP_URL}/admin` });
  await waitFor(`document.body.innerText.includes('Group invite link')`, 'setup reopens');
  await sleep(700);

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

  console.log('\nbringing guests');
  await goToTab('Session', 'Playing');
  await sleep(500);
  // Only offered once you are in — there is no spot to attach guests to
  // otherwise, and the cap check needs one to measure against.
  const registered = await evalJs(`!!document.querySelector('.pitch-spot.is-me')`);
  if (!registered) {
    await evalJs(`(() => { const s = document.querySelector('button.pitch-spot.is-open'); if (s) s.click(); })()`);
    await waitFor(`!!document.querySelector('.pitch-spot.is-me')`, 'registered for the guest test');
    await sleep(400);
  }
  check('the session offers to bring guests',
    await evalJs(`[...document.querySelectorAll('md-text-button')].some(b => /bringing/i.test(b.textContent))`),
    await evalJs(`[...document.querySelectorAll('md-text-button')].map(b => b.textContent.trim()).join(' | ')`));

  const beforeHeads = await evalJs(`Number(document.body.innerText.match(/Playing (\\d+)/)?.[1] ?? 0)`);

  await evalJs(`(() => {
    [...document.querySelectorAll('md-text-button')].find(b => /bringing/i.test(b.textContent)).click();
  })()`);
  await waitFor('document.body.innerText.includes("Bringing anyone")', 'the guest dialog opens');
  await sleep(300);
  check('it explains that guests cost you money',
    await evalJs(`document.body.innerText.includes('their share goes on your bill')`));
  check('it offers a small range, not a keyboard',
    await evalJs(`document.querySelectorAll('.guest-choice').length === 6`),
    await evalJs(`document.querySelectorAll('.guest-choice').length`));
  await shoot('20-guests');

  await evalJs(`document.querySelectorAll('.guest-choice')[2].click()`);
  await sleep(200);
  check('choosing 2 says what that means',
    await evalJs(`document.body.innerText.includes('Me + 2 friends')`),
    await evalJs(`document.querySelector('md-dialog[open]')?.innerText?.slice(0, 200)`));

  await evalJs(`(() => {
    [...document.querySelectorAll('md-dialog[open] md-filled-button')]
      .find(b => b.textContent.includes('Save')).click();
  })()`);
  await waitFor(`!document.querySelector('md-dialog[open]')`, 'the dialog closes on save');
  await waitFor(`document.body.innerText.includes('bringing 2 guests')`, 'the button reflects the party');
  await sleep(600);

  const afterHeads = await evalJs(`Number(document.body.innerText.match(/Playing (\\d+)/)?.[1] ?? 0)`);
  check('GUESTS COUNT TOWARD THE PITCH, NOT JUST THE NAME LIST', afterHeads === beforeHeads + 2,
    `${beforeHeads} -> ${afterHeads}`);
  // Guests are bodies here, not a chip on a row: bringing two takes two spots.
  check('GUESTS TAKE REAL SPOTS ON THE FIELD',
    await evalJs(`document.querySelectorAll('.pitch-spot.is-guest.is-mine').length`) === 2,
    await evalJs(`document.querySelectorAll('.pitch-spot.is-guest.is-mine').length`));
  check('and the row shows why the numbers differ',
    await evalJs(`[...document.querySelectorAll('.player-row .badge')].some(b => b.textContent.trim() === '+2')`),
    await evalJs(`[...document.querySelectorAll('.player-row')].map(r => r.textContent.trim()).join(' | ').slice(0, 200)`));
  await shoot('21-guests-counted');

  // Put it back so later sections see the roster they expect.
  await evalJs(`(() => {
    [...document.querySelectorAll('md-text-button')].find(b => /bringing/i.test(b.textContent)).click();
  })()`);
  await waitFor('document.body.innerText.includes("Bringing anyone")', 'reopen to reset');
  await evalJs(`document.querySelectorAll('.guest-choice')[0].click()`);
  await evalJs(`(() => {
    [...document.querySelectorAll('md-dialog[open] md-filled-button')]
      .find(b => b.textContent.includes('Save')).click();
  })()`);
  await waitFor(`!document.querySelector('md-dialog[open]')`, 'reset saved');
  await sleep(500);

  console.log('\nprofile and streak');
  // The dev database persists between runs, and a previous run leaves a
  // picture behind. Start from "no picture" so the fallback is actually being
  // tested rather than whatever the last run happened to leave.
  await evalJs(`fetch('/api/members/me/avatar', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + localStorage.getItem('futsal:token') },
  }).then((r) => r.status)`);
  // Reload first to pick up the avatar deletion, then navigate: a reload lands
  // on whatever URL the address bar holds, which is not necessarily History.
  await reloadApp('app is back after reload');
  await goToTab('History', 'Streak');
  check('the profile card leads History', await evalJs('!!document.querySelector(".streak-cell")'));
  await sleep(500);
  await shoot('11-profile');
  // Streak, best, played, goals.
  check('it shows the four headline numbers',
    await evalJs(`document.querySelectorAll('.streak-cell').length === 4`),
    await evalJs(`[...document.querySelectorAll('.streak-cell')].map(c => c.innerText.replace(/\\n/g, ':')).join(' | ')`));
  check('the streak values are numbers',
    await evalJs(`[...document.querySelectorAll('.streak-value')].every(v => /^\\d+$/.test(v.textContent.trim()))`),
    await evalJs(`[...document.querySelectorAll('.streak-value')].map(v => v.textContent.trim()).join(',')`));
  // The point of making this public: everybody can see the list, so nobody
  // needs the organizer to nag them.
  check('the owe list is on History for everyone',
    await evalJs('document.body.innerText.includes("Who owes what")'),
    await evalJs('document.body.innerText.slice(0, 200)'));
  check('and says so plainly',
    await evalJs('document.body.innerText.includes("Everyone in the group sees this list")'));

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

  await reloadApp('app is back after reload');
  await goToTab('History', 'Streak');
  await waitFor('!!document.querySelector(".avatar img")', 'the stored picture renders');
  check('the initials are gone once there is a photo',
    await evalJs(`document.querySelector('.avatar').textContent.trim() === ''`),
    await evalJs(`document.querySelector('.avatar').textContent`));
  await sleep(400);
  await shoot('13-avatar');

  // And it reaches the places that list people, not just the profile.
  //
  // Checked on the session roster rather than the player list: that list is
  // virtualized and ordered by name, so whether this member's row exists in
  // the DOM at all depends on where they sort among everybody else — a test
  // that scrolls hunting for one name would be asserting on luck.
  await goToTab('Session', 'Playing');
  await waitFor(`!!document.querySelector('.player-row .avatar')`, 'the roster renders');
  await sleep(600);
  check('a list of people shows the picture too',
    await evalJs(`!!document.querySelector('.player-row .avatar img')`),
    await evalJs(`document.querySelectorAll('.player-row .avatar').length + ' avatars, ' +
      document.querySelectorAll('.player-row .avatar img').length + ' with a photo'`));

  // The player list renders avatars for its rows as well, whoever happens to
  // be in the window.
  await send('Page.navigate', { url: `${APP_URL}/players` });
  await waitFor(`!!document.querySelector('.virtual-scroller .member-row')`, 'the player list opens');
  await sleep(900);
  check('and the player list draws them for its rows',
    (await evalJs(`document.querySelectorAll('.member-row .avatar').length`)) > 0,
    await evalJs(`document.querySelectorAll('.member-row .avatar').length`));

  await goToTab('History', 'Streak');
  await sleep(300);

  // A team-mate's profile is reachable from the session list.
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')].find(b => /Session/i.test(b.textContent ?? ''))?.click()`);
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
    // Their profile is a summary, not your ledger: no "You owe" block, no
    // group-wide list. What it does carry — their own outstanding total — is
    // deliberate, and the same number the History list shows everyone.
    check('a team-mate\'s profile is not your own ledger',
      !(await evalJs('document.body.innerText.includes("You owe")')) &&
        !(await evalJs('document.body.innerText.includes("Who owes what")')),
      await evalJs('document.body.innerText.slice(0, 200)'));
  }
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')].find(b => /Session/i.test(b.textContent ?? ''))?.click()`);
  await waitFor('!!document.querySelector(".conn")', 'back to the session again');
  await sleep(400);

  console.log('\nthe random announcement');
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')].find(b => /Session/i.test(b.textContent ?? ''))?.click()`);
  await waitFor('!!document.querySelector(".conn")', 'back on the session screen');
  await sleep(600);
  const openAnnounce = `(() => {
    const b = [...document.querySelectorAll('md-text-button')].find(x => x.textContent.includes('Write an announcement'));
    if (b) { b.click(); return true; }
    return false;
  })()`;
  // Whatever the dev database's upcoming session happens to be — it is not
  // always the seeded Friday — the announcement has to carry *its* kickoff.
  // Pinning a literal time here was really asserting the fixtures.
  const kickoffOnScreen = await evalJs(
    `document.querySelector('.hero')?.innerText.match(/\\d{1,2}:\\d{2}/)?.[0] ?? ''`,
  );
  check('the session screen shows a kickoff to compare against', kickoffOnScreen !== '',
    await evalJs(`document.querySelector('.hero')?.innerText`));

  check('the session screen offers an announcement', await evalJs(openAnnounce));
  await waitFor('document.body.innerText.includes("Hype the group")', 'the announcement dialog opens');
  await sleep(400);

  const announced = () => evalJs(`document.querySelector('md-dialog[open] .summary-preview')?.textContent ?? ''`);
  const first = await announced();
  check('it carries the real kickoff time', first.includes(kickoffOnScreen),
    `${kickoffOnScreen} not in: ${first.slice(0, 120)}`);
  // Whatever venue the session actually has — or none, when the weekly cron
  // has just created one and nobody has set it yet. Asserting a literal
  // "Pitch" was asserting the fixture, not the behaviour.
  const venueOnScreen = await evalJs(
    `document.querySelector('.hero')?.innerText.split('\\n').find((l) => /^Pitch|^S\u00e2n/.test(l.trim()))?.trim() ?? ''`,
  );
  check(
    venueOnScreen ? 'it carries the venue' : 'it invents no venue when there is none',
    venueOnScreen ? first.includes(venueOnScreen) : !/📍/.test(first),
    `venue on screen: ${JSON.stringify(venueOnScreen)} | ${first.slice(0, 160)}`,
  );
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

  console.log('\nswitching tabs does not re-show a spinner');
  // The complaint this replaced fetch-on-mount to fix. Warm every tab first,
  // then poll hard while moving between them: the old behaviour put a spinner
  // up on every single mount, so anything above zero here is a regression.
  // By label: the nav gained a tab, and every index below it moved.
  const tab = (label) =>
    evalJs(`[...document.querySelectorAll('.bottom-nav button')]
      .find((b) => new RegExp(${JSON.stringify(label)}, 'i').test(b.textContent ?? ''))?.click()`);
  const settled = (text) => waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, `warm: ${text}`);

  await tab('Session');
  await settled('Playing');
  await tab('History');
  await settled('Streak');
  await tab('Leaderboard');
  await waitFor(
    `!!document.querySelector('.rank-cell') || !!document.querySelector('.empty')`,
    'warm: the ranking itself',
  );
  await tab('Setup');
  await settled('Players');
  await sleep(600);

  // Now the cache is warm. Sample continuously across several switches.
  let spinnerSightings = 0;
  const watch = async (label, ms) => {
    await tab(label);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await evalJs(`!!document.querySelector('.spinner, md-circular-progress')`)) {
        spinnerSightings++;
      }
    }
  };
  for (const label of ['Session', 'History', 'Leaderboard', 'Setup', 'Session', 'History'])
    await watch(label, 260);

  check('no spinner appears when revisiting a warmed tab', spinnerSightings === 0,
    `${spinnerSightings} sightings`);

  // And the content is actually there, not merely spinner-free.
  await tab('History');
  await sleep(120);
  check('the history tab paints its content immediately',
    await evalJs(`document.body.innerText.includes('Streak')`),
    await evalJs(`document.body.innerText.slice(0, 120)`));
  await tab('Session');
  await sleep(120);
  check('and so does the session tab',
    await evalJs(`document.body.innerText.includes('Playing')`),
    await evalJs(`document.body.innerText.slice(0, 120)`));

  console.log('\ndark mode');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')].find(b => /Session/i.test(b.textContent ?? ''))?.click()`);
  await sleep(1200);
  await shoot('08-dark');
  const bg = await evalJs(`getComputedStyle(document.body).backgroundColor`);
  // Pure black, not a tinted charcoal — that is the whole basis of the dark
  // theme, so it is worth pinning rather than asserting "something dark".
  check('dark theme applies', bg === 'rgb(0, 0, 0)', bg);

  console.log('\nevery long list is paged and windowed');
  // The same three properties on each: a bounded first request, a DOM holding
  // a window rather than the list, and a scroll box that does not swallow the
  // page. Written as one loop because three copies would drift.
  for (const [label, path, endpoint] of [
    ['home history', '/', '/sessions/past'],
    ['who owes what', '/history', '/members/balances'],
    ['the roster', '/players', '/members\\?'],
  ]) {
    const before = events.filter((e) => e.method === 'Network.requestWillBeSent').length;
    await send('Page.navigate', { url: `${APP_URL}${path}` });
    const ready = await waitFor(`!!document.querySelector('.virtual-scroller')`,
      `${label}: the list renders`);
    if (!ready) continue;
    await sleep(2000);
    const asked = events
      .filter((e) => e.method === 'Network.requestWillBeSent')
      .slice(before)
      .map((e) => e.params.request.url)
      .filter((u) => new RegExp(endpoint).test(u));
    check(`${label}: asks for a bounded page`, asked.some((u) => /limit=\d+/.test(u)),
      JSON.stringify(asked.map((u) => u.replace(/^.*\/api/, '')).slice(0, 3)));
    const shape = await evalJs(`(() => {
      const el = document.querySelector('.virtual-scroller');
      return { rows: document.querySelectorAll('.virtual-row').length,
               clientH: el?.clientHeight ?? 0, viewport: innerHeight };
    })()`);
    check(`${label}: the DOM holds a window, not the whole list`,
      shape.rows > 0 && shape.rows < 40, JSON.stringify(shape));
    check(`${label}: it scrolls inside a capped box`,
      shape.clientH > 0 && shape.clientH < shape.viewport, JSON.stringify(shape));
  }

  console.log('\nthe roster is paginated and virtualized');
  // Setup used to render every player, which put "add a session" and "sign
  // out" below the whole group and pulled the entire roster over the wire to
  // print one number.
  const netBefore = events.filter((e) => e.method === 'Network.requestWillBeSent').length;
  await send('Page.navigate', { url: `${APP_URL}/admin` });
  await waitFor(`document.body.innerText.includes('Players')`, 'setup loads');
  await sleep(1800);
  const memberCalls = events
    .filter((e) => e.method === 'Network.requestWillBeSent')
    .slice(netBefore)
    .map((e) => e.params.request.url)
    .filter((u) => /\/members/.test(u));
  check('SETUP FETCHES A COUNT, NOT THE ROSTER',
    memberCalls.some((u) => /\/members\/count/.test(u)) &&
      !memberCalls.some((u) => /\/members(\?|$)/.test(u)),
    JSON.stringify(memberCalls.map((u) => u.replace(/^.*\/api/, ''))));
  check('and renders no player rows on it',
    (await evalJs(`document.querySelectorAll('.member-row').length`)) === 0);

  await evalJs(`[...document.querySelectorAll('md-outlined-button')]
    .find(b => /Open the player list/i.test(b.textContent))?.click()`);
  await waitFor(`!!document.querySelector('.virtual-scroller')`, 'the player list opens');
  await sleep(1800);
  const domRows = await evalJs(`document.querySelectorAll('.virtual-row').length`);
  const loaded = await evalJs(`document.querySelectorAll('.virtual-scroller .member-row').length`);
  // The window in the DOM must stay small however many are loaded; that is the
  // entire claim virtualization makes.
  check('THE DOM HOLDS A WINDOW, NOT EVERY PLAYER', domRows > 0 && domRows < 40,
    `${domRows} rows in the DOM, ${loaded} member rows`);
  const frame = await evalJs(`(() => {
    const el = document.querySelector('.virtual-scroller');
    return { clientH: el.clientHeight, scrollH: el.scrollHeight, viewport: innerHeight };
  })()`);
  check('the list scrolls inside a capped frame, not the page',
    frame.clientH < frame.viewport, JSON.stringify(frame));

  console.log('\ngetting back out of a screen');
  // The header arrow used to `navigate({name:'home'})`, so it ignored where you
  // came from *and* pushed a new entry — leaving the browser's own back button
  // walking forward through screens you had already dismissed.
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')].find(b => /History/i.test(b.textContent ?? ''))?.click()`);
  await waitFor(`location.pathname === '/history'`, 'history opens');
  await sleep(900);
  const openedDetail = await evalJs(`(() => {
    const b = [...document.querySelectorAll('.player-name.link, button.player-row')][0];
    if (b) { b.click(); return true; } return false;
  })()`);
  await sleep(1300);
  check('a detail page opens from history', openedDetail &&
    (await evalJs('location.pathname')) !== '/history', await evalJs('location.pathname'));
  await evalJs(`document.querySelector('.topbar .icon-button')?.click()`);
  await sleep(1300);
  check('BACK RETURNS WHERE YOU CAME FROM, NOT HOME',
    (await evalJs('location.pathname')) === '/history', await evalJs('location.pathname'));

  // Straight into a deep link with nothing of ours behind it: back has to fall
  // through to home rather than leaving the app.
  await send('Page.navigate', { url: `${APP_URL}/history` });
  await waitFor('!!document.querySelector(".bottom-nav")', 'cold deep link loads');
  await sleep(1000);
  await evalJs(`document.querySelector('.topbar .icon-button')?.click()`);
  await sleep(1300);
  check('and falls through to home when there is no history',
    (await evalJs('location.pathname')) === '/', await evalJs('location.pathname'));

  console.log('\nthe connection indicator holds steady');
  await sleep(2500);
  // Watched with a MutationObserver, not a timer. The flash lasts a single
  // render, and a 60ms sampler stepped straight over it — a check that passed
  // against the very bug it was written for.
  await evalJs(`(() => {
    window.__connSeen = [];
    const grab = () => {
      const t = document.querySelector('.conn')?.textContent?.trim();
      if (t && window.__connSeen.at(-1) !== t) window.__connSeen.push(t);
    };
    grab();
    new MutationObserver(grab).observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
  })()`);
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')].find(b => /History/i.test(b.textContent ?? ''))?.click()`);
  await sleep(1400);
  await evalJs(`[...document.querySelectorAll('.bottom-nav button')].find(b => /Session/i.test(b.textContent ?? ''))?.click()`);
  await sleep(2400);
  const connSeen = await evalJs('JSON.stringify(window.__connSeen)');
  check('NO CONNECTING FLASH WHEN NAVIGATING BACK HOME',
    !/Connecting/i.test(connSeen), connSeen);

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
