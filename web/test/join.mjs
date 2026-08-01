/**
 * The group join link, driven in a real browser.
 *
 * This is the path a person who has never opened the app takes: they tap a
 * link somebody pasted into the group chat, see a list of names, and tap
 * theirs. It runs in its own suite because every other suite starts already
 * signed in, and the interesting behaviour here is what an *unauthenticated*
 * visitor can and cannot do.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveEveryonePending,
  clearTestMembers,
  localGroupJoinPath,
  localUnclaimedMember,
} from './helpers.mjs';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// A port derived from the pid, so a suite left running by an interrupted run
// cannot serve this one an already-signed-in profile.
const PORT = 9600 + (process.pid % 30);
const OUT_DIR = process.env.SHOTS_DIR ?? '/tmp/ff-shots';
const APP_URL = (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');

const profile = mkdtempSync(join(tmpdir(), 'ff-join-'));
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

let nextId = 1;
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
  return { send, ready };
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : `\n         ${detail}`}`);
}

let browser;

/**
 * A separate *person*, not just a separate tab.
 *
 * Tabs in one profile share `localStorage`, so once one of them signs in the
 * rest are signed in too — which would quietly turn every "second visitor"
 * assertion below into a test of the wrong thing. Each visitor therefore gets
 * its own browser context, which is the closest thing to a different phone.
 */
async function newVisitor() {
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const { targetId } = await browser.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.id === targetId);
  const { send, ready } = connect(target.webSocketDebuggerUrl);
  await ready;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('futsal:locale', 'en'); } catch {}`,
  });

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, label, timeout = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evalJs(expression)) return true;
      await sleep(150);
    }
    check(label, false, `timed out waiting for: ${expression}`);
    return false;
  };
  const shoot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
  };
  return { send, evalJs, waitFor, shoot };
}

const nameOfButtons = `[...document.querySelectorAll('md-outlined-button')].map(b => b.textContent.trim())`;

async function run() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
    } catch {}
    await sleep(200);
  }

  const bws = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  browser = connect(bws.webSocketDebuggerUrl);
  await browser.ready;

  clearTestMembers();
  const bao = localUnclaimedMember('Bao Join-Test');
  localUnclaimedMember('Chi Join-Test');
  const joinPath = localGroupJoinPath();

  console.log('\nopening the group link');
  const a = await newVisitor();
  await a.send('Page.navigate', { url: `${APP_URL}${joinPath}` });
  await a.waitFor('document.body.innerText.includes("Which one are you")', 'the name picker appears');
  await sleep(500);
  await a.shoot('10-join');

  const offered = await a.evalJs(nameOfButtons);
  check('offers the unclaimed names', offered.includes('Bao Join-Test') && offered.includes('Chi Join-Test'),
    JSON.stringify(offered));
  // The whole reason this link is safe to paste in a group chat.
  check('does NOT offer the organizer', !offered.some((n) => /organizer/i.test(n)), JSON.stringify(offered));

  console.log('\na rotated link stops working');
  const b = await newVisitor();
  await b.send('Page.navigate', { url: `${APP_URL}/join#${'z'.repeat(43)}` });
  await b.waitFor('document.body.innerText.includes("not valid any more")', 'a dead link says so');
  await b.shoot('11-join-dead');
  check('and offers no names at all', (await b.evalJs(nameOfButtons)).filter((n) => n !== 'EN' && n !== 'မြန်မာ').length === 0,
    JSON.stringify(await b.evalJs(nameOfButtons)));

  console.log('\ntaking a name');
  await a.evalJs(`(() => {
    const b = [...document.querySelectorAll('md-outlined-button')].find(x => x.textContent.includes('Bao Join-Test'));
    b.click();
  })()`);
  await a.waitFor('!!document.querySelector(".bottom-nav")', 'signing in lands on the app');
  check('signed in as the name that was tapped',
    await a.evalJs(`document.querySelector('.topbar-sub')?.textContent.includes('Bao Join-Test')`),
    await a.evalJs(`document.querySelector('.topbar-sub')?.textContent`));
  check('the nonce is stripped from the address bar', await a.evalJs('location.hash === ""'),
    await a.evalJs('location.hash'));
  await sleep(800);
  await a.shoot('12-join-signed-in');

  console.log('\nthe name is gone for the next person');
  const c = await newVisitor();
  await c.send('Page.navigate', { url: `${APP_URL}${joinPath}` });
  await c.waitFor('document.body.innerText.includes("Which one are you")', 'a second visitor sees the picker');
  await sleep(400);
  const left = await c.evalJs(nameOfButtons);
  check('the taken name is no longer offered', !left.includes('Bao Join-Test'), JSON.stringify(left));
  check('the others still are', left.includes('Chi Join-Test'), JSON.stringify(left));

  console.log('\nracing for the same name');
  // Two tabs both holding a list that still shows Chi; the loser must be told,
  // not silently signed in as somebody else.
  const d = await newVisitor();
  await d.send('Page.navigate', { url: `${APP_URL}${joinPath}` });
  await d.waitFor('document.body.innerText.includes("Which one are you")', 'a third visitor sees the picker');
  await sleep(400);

  const tapChi = `(() => {
    const b = [...document.querySelectorAll('md-outlined-button')].find(x => x.textContent.includes('Chi Join-Test'));
    if (!b) return false;
    b.click();
    return true;
  })()`;
  check('both tabs still offer Chi', (await c.evalJs(tapChi)) === true);
  await c.waitFor('!!document.querySelector(".bottom-nav")', 'the first tap wins');
  await d.evalJs(tapChi);
  await d.waitFor('document.body.innerText.includes("already took that name")', 'the second tap is refused');
  await d.shoot('13-join-race');
  check('the loser is not signed in as anybody', !(await d.evalJs('!!document.querySelector(".bottom-nav")')));
  check('and the list refreshes without the taken name',
    !(await d.evalJs(nameOfButtons)).includes('Chi Join-Test'),
    JSON.stringify(await d.evalJs(nameOfButtons)));

  console.log('\nadding yourself when your name is not listed');
  const walkin = await newVisitor();
  await walkin.send('Page.navigate', { url: `${APP_URL}${joinPath}` });
  await walkin.waitFor('document.body.innerText.includes("Which one are you")', 'the picker loads');
  await sleep(400);
  check('the picker offers a way in for people not on the list',
    await walkin.evalJs(`[...document.querySelectorAll('md-text-button')].some(b => b.textContent.includes("My name isn't here"))`));

  await walkin.evalJs(`(() => {
    [...document.querySelectorAll('md-text-button')].find(b => b.textContent.includes("My name isn't here")).click();
  })()`);
  await walkin.waitFor('document.body.innerText.includes("Add your name")', 'the name dialog opens');
  await sleep(300);
  await walkin.evalJs(`(() => {
    const f = document.querySelector('md-dialog[open] md-outlined-text-field');
    f.value = 'Walkin Join-Test';
    f.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  })()`);
  await sleep(250);
  await walkin.evalJs(`(() => {
    [...document.querySelectorAll('md-dialog[open] md-filled-button')]
      .find(b => b.textContent.includes('Add your name')).click();
  })()`);

  await walkin.waitFor('document.body.innerText.includes("Almost in")', 'they land in the waiting room');
  await sleep(400);
  await walkin.shoot('14-waiting');
  check('the waiting screen names them',
    await walkin.evalJs(`document.body.innerText.includes('Walkin Join-Test')`),
    (await walkin.evalJs('document.body.innerText.slice(0, 160)')).replace(/\n/g, ' | '));
  // The whole point of the waiting room: a forwarded link reveals nothing.
  check('AND SHOWS NOTHING ABOUT THE GROUP',
    !(await walkin.evalJs(`!!document.querySelector('.bottom-nav')`)) &&
      !(await walkin.evalJs(`document.body.innerText.includes('Dave Join-Test')`)),
    (await walkin.evalJs('document.body.innerText.slice(0, 200)')).replace(/\n/g, ' | '));

  await walkin.evalJs(`(() => {
    [...document.querySelectorAll('md-outlined-button')].find(b => b.textContent.includes('Check again')).click();
  })()`);
  await walkin.waitFor('document.body.innerText.includes("Not yet")', 'checking again says not yet');

  approveEveryonePending();

  await walkin.evalJs(`(() => {
    [...document.querySelectorAll('md-outlined-button')].find(b => b.textContent.includes('Check again')).click();
  })()`);
  await walkin.waitFor('!!document.querySelector(".bottom-nav")', 'approval lets them into the app');
  check('and the existing session becomes usable',
    await walkin.evalJs(`document.body.innerText.includes('Playing')`),
    (await walkin.evalJs('document.body.innerText.slice(0, 160)')).replace(/\n/g, ' | '));
  await sleep(400);
  await walkin.shoot('15-let-in');

  console.log('\npasting a link, the way a home-screen PWA has to');
  const pwa = await newVisitor();
  // No fragment: this is what launching from the home screen looks like, and
  // what a chat webview leaves behind after signing in somewhere else.
  await pwa.send('Page.navigate', { url: `${APP_URL}/join` });
  await pwa.waitFor('document.body.innerText.includes("Got a link?")',
    'a bare /join offers the paste box instead of an error');
  await sleep(400);
  await pwa.shoot('17-paste');

  const typeLink = async (value) => {
    await pwa.evalJs(`(() => {
      const f = [...document.querySelectorAll('md-outlined-text-field')].at(-1);
      f.value = ${JSON.stringify(value)};
      f.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    })()`);
    await sleep(250);
    await pwa.evalJs(`(() => {
      [...document.querySelectorAll('md-filled-button')]
        .find((b) => b.textContent.includes('Use this link')).click();
    })()`);
  };

  await typeLink('https://example.test/not-a-link');
  await pwa.waitFor(`document.body.innerText.includes("doesn't look like an invite link")`,
    'rubbish is rejected with an explanation');

  // The whole URL, exactly as it would be copied out of a group chat.
  await typeLink(`https://futsal-friday.pages.dev${joinPath}`);
  await pwa.waitFor('document.body.innerText.includes("Which one are you")',
    'a pasted group link opens the name picker');
  await sleep(400);
  const pastedNames = await pwa.evalJs(nameOfButtons);

  // The invariant is that pasting a link is indistinguishable from tapping it,
  // so compare against a visitor who tapped — naming a member here would only
  // assert what this suite happened to leave unclaimed.
  const tapped = await newVisitor();
  await tapped.send('Page.navigate', { url: `${APP_URL}${joinPath}` });
  await tapped.waitFor('document.body.innerText.includes("Which one are you")', 'tapped visit loads');
  await sleep(300);
  const tappedNames = await tapped.evalJs(nameOfButtons);

  check('the pasted picker is not empty', pastedNames.length > 0);
  check('and offers exactly what tapping the link would',
    JSON.stringify(pastedNames) === JSON.stringify(tappedNames),
    `pasted ${pastedNames.length} vs tapped ${tappedNames.length}`);
  await pwa.shoot('18-pasted-picker');

  // A bare code carries no path, so the app has to work out which sort it is.
  const bare = await newVisitor();
  await bare.send('Page.navigate', { url: `${APP_URL}/` });
  await bare.waitFor('document.body.innerText.includes("Got a link?")', 'the home screen offers it too');
  await sleep(300);
  await bare.evalJs(`(() => {
    const f = [...document.querySelectorAll('md-outlined-text-field')].at(-1);
    f.value = ${JSON.stringify(joinPath.split('#')[1])};
    f.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  })()`);
  await sleep(250);
  await bare.evalJs(`(() => {
    [...document.querySelectorAll('md-filled-button')]
      .find((b) => b.textContent.includes('Use this link')).click();
  })()`);
  await bare.waitFor('document.body.innerText.includes("Which one are you")',
    'a bare code is resolved to the group link');

  void bao;
  clearTestMembers();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  chrome.kill();
  process.exit(failed.length === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('Join test crashed:', e);
  try { clearTestMembers(); } catch {}
  chrome.kill();
  process.exit(1);
});
