/**
 * Burmese localisation, in a browser reporting a Burmese device language.
 *
 * Checks the parts a catalogue test cannot: that auto-detection picks Burmese,
 * that Myanmar script renders without clipping its stacked diacritics, that a
 * script with no inter-word spaces does not overflow its container, and that
 * switching language persists and takes effect immediately.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localClaimPath, localOrganizerId } from './helpers.mjs';
const CHROME=process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT=process.env.SHOTS_DIR ?? '/tmp/ff-my';
const APP_URL=(process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/,''); mkdirSync(OUT,{recursive:true});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const res=[]; const check=(l,ok,d)=>{res.push(ok);console.log(`  ${ok?'ok  ':'FAIL'} ${l}${ok||d===undefined?'':`\n         ${d}`}`)};
const profile=mkdtempSync(join(tmpdir(),'ff-my-'));
// Unique port + unconditional cleanup: a leftover browser from an aborted run
// would otherwise serve an already-signed-in profile and fail confusingly.
const PORT = 9500 + (process.pid % 30);
const chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','--hide-scrollbars','--lang=my-MM','about:blank'],{stdio:'ignore'});
const killChrome = () => { try { chrome.kill(); } catch {} };
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, killChrome);
// Registering a handler for 'uncaughtException' replaces Node's default of
// printing the error and exiting non-zero — so it must do both itself, or a
// crash here exits 0 with the failure invisible.
process.on('uncaughtException', (error) => {
  console.error('\ncrashed:', error);
  killChrome();
  process.exit(1);
});
for(let i=0;i<60;i++){try{if((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok)break}catch{}await sleep(200)}
const t=await(await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:'PUT'})).json();
let id=1;const ws=new WebSocket(t.webSocketDebuggerUrl);const pend=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const{resolve,reject}=pend.get(m.id);pend.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result)}});
await new Promise(r=>ws.addEventListener('open',r));
const send=(method,params={})=>new Promise((rs,rj)=>{const i=id++;pend.set(i,{resolve:rs,reject:rj});ws.send(JSON.stringify({id:i,method,params}))});
await send('Page.enable');await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
// --lang changes Chrome's own UI, not navigator.language; this is what a
// Burmese phone actually reports.
await send('Emulation.setUserAgentOverride',{userAgent:await (async()=>{const r=await send('Browser.getVersion');return r.userAgent})(),acceptLanguage:'my-MM,my;q=0.9',platform:'iPhone'});
const js=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value};
const waitFor=async(e,l,ms=15000)=>{const s=Date.now();while(Date.now()-s<ms){if(await js(e))return true;await sleep(200)}check(l,false,`timeout: ${e}`);return false};
const shoot=async n=>{const{data}=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(OUT,`${n}.png`),Buffer.from(data,'base64'))};

console.log('\nBurmese device opens in Burmese');
await send('Page.navigate',{url:APP_URL+'/'});
await waitFor('!!document.querySelector("#root")?.children.length','mounts');
await sleep(1200);
console.log('         navigator.languages =', await js('JSON.stringify(navigator.languages)'));
check('auto-detected Burmese from device language', await js(`document.documentElement.lang === 'my'`), await js(`document.documentElement.lang`));
check('sign-in screen is in Burmese', await js(`document.body.innerText.includes('စီစဉ်သူထံ တောင်းပါ')`), (await js('document.body.innerText')).slice(0,90).replace(/\n/g,' | '));
await shoot('01-gate-my');

console.log('\nsign in with a claim link');
await send('Page.navigate',{url:APP_URL+localClaimPath(localOrganizerId())});
await waitFor('!!document.querySelector(".bottom-nav")','shell');
await sleep(2000);
await shoot('02-home-my');

const body = await js('document.body.innerText');
check('nav is in Burmese', body.includes('ပွဲ') && body.includes('မှတ်တမ်း') && body.includes('ဆက်တင်'), body.slice(-60).replace(/\n/g,' | '));
check('register button is in Burmese', body.includes('ကစားမည်'), body.slice(0,120).replace(/\n/g,' | '));
check('weekday rendered in Burmese', /တနင်္ဂနွေ|တနင်္လာ|အင်္ဂါ|ဗုဒ္ဓဟူး|ကြာသပတေး|သောကြာ|စနေ/.test(body), body.slice(0,120).replace(/\n/g,' | '));
check('no raw catalogue keys leaked', !/\b(session|payments|admin|reminders)\.[a-zA-Z]/.test(body), body.slice(0,200));

console.log('\nlayout holds (no clipping or horizontal overflow)');
check('no horizontal overflow', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`),
  await js(`document.documentElement.scrollWidth + ' vs ' + window.innerWidth`));
check('taller line-height applied for Burmese',
  await js(`parseFloat(getComputedStyle(document.body).lineHeight) >= 24`),
  await js(`getComputedStyle(document.body).lineHeight`));
const overflowing = await js(`(() => {
  const bad = [];
  for (const el of document.querySelectorAll('.card, .hero, .player-row, .bottom-nav button, .badge')) {
    if (el.scrollWidth > el.clientWidth + 2) bad.push(el.className + ':' + el.scrollWidth + '>' + el.clientWidth);
  }
  return JSON.stringify(bad.slice(0,5));
})()`);
check('no element overflows its box', overflowing === '[]', overflowing);

console.log('\nthe Burmese profile card');
await js(`[...document.querySelectorAll('.bottom-nav button')][1].click()`);
await waitFor(`!!document.querySelector('.streak-cell')`, 'profile card renders in Burmese');
await sleep(600);
await shoot('05-profile-my');
check('streak labels are in Burmese',
  await js(`[...document.querySelectorAll('.streak-label')].every(l => /[\u1000-\u109F]/.test(l.textContent))`),
  await js(`[...document.querySelectorAll('.streak-label')].map(l => l.textContent).join('|')`));
check('the counts stay in Arabic numerals',
  await js(`[...document.querySelectorAll('.streak-value')].every(v => /^\\d+$/.test(v.textContent.trim()))`),
  await js(`[...document.querySelectorAll('.streak-value')].map(v => v.textContent.trim()).join(',')`));
// Three narrow cells with Burmese labels is the most likely place to overflow.
check('no streak cell overflows its box',
  await js(`[...document.querySelectorAll('.streak-cell')].every(c => c.scrollWidth <= c.clientWidth + 2)`),
  await js(`[...document.querySelectorAll('.streak-cell')].map(c => c.scrollWidth+'>'+c.clientWidth).join('|')`));
check('the three cells stay the same height',
  await js(`(() => { const h = [...document.querySelectorAll('.streak-cell')].map(c => Math.round(c.getBoundingClientRect().height)); return new Set(h).size === 1; })()`),
  await js(`[...document.querySelectorAll('.streak-cell')].map(c => Math.round(c.getBoundingClientRect().height)).join(',')`));
// Either branch is correct — a previous suite may have left a picture on this
// account. What matters is that the circle is never blank. The grapheme
// handling behind the initials is unit-tested against real Burmese names in
// shared/test.
check('the avatar renders something, picture or initials',
  await js(`(() => {
    const a = document.querySelector('.avatar');
    return !!a && (!!a.querySelector('img') || a.textContent.trim().length > 0);
  })()`),
  await js(`document.querySelector('.avatar')?.outerHTML?.slice(0, 120)`));
await js(`[...document.querySelectorAll('.bottom-nav button')][0].click()`);
await waitFor(`!!document.querySelector('.conn')`, 'back to the session screen');
await sleep(500);

console.log('\nthe Burmese announcement');
await js(`(()=>{const b=[...document.querySelectorAll('md-text-button')].find(x=>x.textContent.includes('ကြေညာချက် ရေးမယ်'));if(b)b.click()})()`);
await waitFor(`document.body.innerText.includes('အုပ်စုကို လှုံ့ဆော်မယ်')`, 'announcement dialog opens in Burmese');
await sleep(500);
await shoot('04-announce-my');
const ann = await js(`document.querySelector('md-dialog[open] .summary-preview')?.textContent ?? ''`);
check('the announcement is in Myanmar script', /[\u1000-\u109F]/.test(ann), ann.slice(0,80).replace(/\n/g,' | '));
check('it still carries the real kickoff', /\d{2}:\d{2}/.test(ann), ann.slice(0,120).replace(/\n/g,' | '));
// A bare `monospace` has no Myanmar glyphs on most systems, so the preview
// needs the same fall-through the rest of the app uses.
check('the preview font falls through to a Myanmar face',
  await js(`/Myanmar|Padauk|Noto Sans Myanmar/.test(getComputedStyle(document.querySelector('md-dialog[open] .summary-preview')).fontFamily)`),
  await js(`getComputedStyle(document.querySelector('md-dialog[open] .summary-preview')).fontFamily`));
check('the preview does not overflow sideways',
  await js(`(()=>{const p=document.querySelector('md-dialog[open] .summary-preview');return p.scrollWidth <= p.clientWidth + 2})()`),
  await js(`(()=>{const p=document.querySelector('md-dialog[open] .summary-preview');return p.scrollWidth+'>'+p.clientWidth})()`));
check('and gives the stacked diacritics room',
  await js(`parseFloat(getComputedStyle(document.querySelector('md-dialog[open] .summary-preview')).lineHeight) >= 18`),
  await js(`getComputedStyle(document.querySelector('md-dialog[open] .summary-preview')).lineHeight`));
await js(`document.querySelector('md-dialog[open]')?.close()`);
await sleep(400);

console.log('\nswitch to English and back');
await js(`[...document.querySelectorAll('.bottom-nav button')][2].click()`);
await waitFor(`document.body.innerText.includes('ဘာသာစကား')`,'language card in Burmese');
await sleep(600);
await shoot('03-setup-my');
await js(`(()=>{const b=[...document.querySelectorAll('md-outlined-button,md-filled-button')].find(x=>x.textContent.trim()==='English');if(b)b.click()})()`);
await sleep(1200);
check('switched to English', await js(`document.documentElement.lang === 'en'`), await js(`document.documentElement.lang`));
check('English strings render', await js(`document.body.innerText.includes('Language')`));
await shoot('04-setup-en');
await js(`(()=>{const b=[...document.querySelectorAll('md-outlined-button,md-filled-button')].find(x=>x.textContent.trim()==='မြန်မာ');if(b)b.click()})()`);
await sleep(1200);
check('switched back to Burmese', await js(`document.documentElement.lang === 'my'`));
check('choice persisted to storage', await js(`localStorage.getItem('futsal:locale') === 'my'`), await js(`localStorage.getItem('futsal:locale')`));

console.log('\npayments screen in Burmese');
await js(`[...document.querySelectorAll('.bottom-nav button')][0].click()`);
await sleep(1500);
await shoot('05-session-my');

const failed=res.filter(r=>!r).length;
console.log(`\n${res.length-failed} passed, ${failed} failed`);
chrome.kill();process.exit(failed===0?0:1);
