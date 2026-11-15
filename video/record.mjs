/**
 * Records the IntentGuard demo: slides + the live app, with a visible cursor and burned-in
 * captions, as 1080p JPEG frames (CDP screencast) plus a timeline of narration, sound cues
 * and edit points. build.mjs turns this into the final video.
 *
 * Prereqs: `npm run dev` in the repo (API :8787, UI :5173); `python video/tts.py` already run.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, 'build');
const FRAMES = path.join(BUILD, 'frames');
const APP = process.env.APP_URL || 'http://localhost:5173/';
const API = process.env.API_URL || 'http://localhost:8787';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const script = JSON.parse(readFileSync(path.join(HERE, 'script.json'), 'utf8'));
const durations = JSON.parse(readFileSync(path.join(BUILD, 'voice', 'durations.json'), 'utf8'));
const lines = Object.fromEntries(script.lines.map((l) => [l.id, l]));

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const now = () => Date.now() / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
const log = (type, extra = {}) => events.push({ type, t: now(), ...extra });

// ---------------------------------------------------------------------------
// Overlay: captions + cursor, injected into every page (slides and app)
// ---------------------------------------------------------------------------
const OVERLAY = `
(() => {
  const install = () => {
    if (document.getElementById('ig-cap')) return;
    const st = document.createElement('style');
    st.textContent = \`
      #ig-cap { position:fixed; left:50%; bottom:84px; transform:translateX(-50%) translateY(8px); z-index:2147483647;
        max-width:980px; width:max-content; padding:12px 24px; border-radius:14px; text-align:center;
        background:rgba(9,10,13,.82); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
        border:1px solid rgba(255,255,255,.08); box-shadow:0 10px 40px rgba(0,0,0,.45);
        color:#f3f4f7; font:500 22px/1.38 Inter, system-ui, sans-serif; letter-spacing:-.005em;
        opacity:0; transition:opacity .22s ease, transform .22s ease; pointer-events:none; }
      #ig-cap.on { opacity:1; transform:translateX(-50%) translateY(0); }
      #ig-cur { position:fixed; left:0; top:0; z-index:2147483647; width:30px; height:30px; pointer-events:none;
        transform:translate(640px,420px); transition:transform .75s cubic-bezier(.22,.8,.25,1), opacity .3s; opacity:0;
        filter:drop-shadow(0 3px 6px rgba(0,0,0,.6)); }
      #ig-cur.on { opacity:1; }
      .ig-ripple { position:fixed; z-index:2147483646; width:16px; height:16px; margin:-8px 0 0 -8px; border-radius:50%;
        border:2px solid rgba(255,138,76,.9); pointer-events:none; animation:igr .55s ease-out forwards; }
      @keyframes igr { from { transform:scale(.4); opacity:1 } to { transform:scale(3.2); opacity:0 } }
      ::-webkit-scrollbar { display:none; }
      #ig-fade { position:fixed; inset:0; z-index:2147483647; background:#050608; pointer-events:none; opacity:1; transition:opacity .5s ease; }\`;
    document.documentElement.appendChild(st);
    const fade = document.createElement('div'); fade.id = 'ig-fade'; document.documentElement.appendChild(fade);
    requestAnimationFrame(() => requestAnimationFrame(() => { fade.style.opacity = '0'; }));
    const cap = document.createElement('div'); cap.id = 'ig-cap'; document.documentElement.appendChild(cap);
    const cur = document.createElement('div'); cur.id = 'ig-cur';
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2.5l15.5 9.2-6.9 1.3 3.9 7.1-3 1.6-3.9-7.2-5.1 4.6z" fill="#fff" stroke="#0b0c10" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cur);
    window.__ig = {
      fadeOut() { const f = document.getElementById('ig-fade'); f.style.transition = 'opacity .4s ease'; f.style.opacity = '1'; },
      cap(text) { const c = document.getElementById('ig-cap'); if (!text) { c.classList.remove('on'); return; } c.textContent = text; c.classList.add('on'); },
      cursor(on, x, y) { const k = document.getElementById('ig-cur'); k.classList.toggle('on', on); if (x !== undefined) k.style.transform = 'translate(' + x + 'px,' + y + 'px)'; },
      ripple(x, y) { const r = document.createElement('div'); r.className = 'ig-ripple'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700); },
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();`;

// ---------------------------------------------------------------------------
// Browser + screencast
// ---------------------------------------------------------------------------
// Real 1280x720 page at 2x pixel density -> true 2560x1440 frames. (Playwright's emulated viewport
// would make headless Chrome capture a squashed 1280x633 surface; the window includes 87px of
// invisible browser UI, hence 807.)
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--force-device-scale-factor=2', '--window-size=1280,807', '--hide-scrollbars', '--force-color-profile=srgb'],
});
const ctx = await browser.newContext({ viewport: null });
await ctx.addInitScript(OVERLAY);
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const frames = [];
let frameNo = 0;
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const file = path.join(FRAMES, `f${String(++frameNo).padStart(6, '0')}.jpg`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ t: metadata.timestamp, file });
  try {
    await cdp.send('Page.screencastFrameAck', { sessionId });
  } catch {
    /* page navigating */
  }
});
let casting = false;
async function screencast() {
  if (casting) return; // the screencast survives navigations within the tab
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 2560, maxHeight: 1440, everyNthFrame: 1 });
  casting = true;
  const dims = await page.evaluate(() => `${innerWidth}x${innerHeight}@${devicePixelRatio}`);
  if (dims !== '1280x720@2') throw new Error(`unexpected capture geometry ${dims}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let cursorPos = { x: 720, y: 480 };

/** Speak a narration line: logs its start for the audio mix and shows timed caption chunks. */
async function say(id, { tail = 0.35 } = {}) {
  const line = lines[id];
  const dur = durations[id].duration;
  log('voice', { id });
  const chunks = chunkCaption(line.caption);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  let acc = 0;
  for (const c of chunks) {
    const start = (acc / total) * dur;
    const end = ((acc + c.length) / total) * dur;
    acc += c.length;
    setTimeout(() => {
      page.evaluate((t) => window.__ig?.cap(t), c).catch(() => {});
      log('caption', { text: c, end: now() + (end - start) });
    }, start * 1000);
  }
  await sleep((dur + tail) * 1000);
  await page.evaluate(() => window.__ig?.cap('')).catch(() => {});
}

/**
 * Split a caption into readable chunks (<= ~90 chars). Never joins two sentences; a long
 * sentence is split once, at the clause boundary closest to its middle.
 */
function chunkCaption(text) {
  // sentence = punctuation followed by whitespace, so "4.5" or "$1,000.00" never splits
  const sentences = text.split(/(?<=[.!?]["”']?)\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  const split = (s) => {
    if (s.length <= 90) return [s];
    const cuts = [...s.matchAll(/[,:;]\s+/g)].map((m) => m.index + 1);
    const pool = cuts.length ? cuts : [...s.matchAll(/\s+/g)].map((m) => m.index);
    const mid = pool.reduce((b, c) => (Math.abs(c - s.length / 2) < Math.abs(b - s.length / 2) ? c : b));
    return [...split(s.slice(0, mid).trim()), ...split(s.slice(mid).trim())];
  };
  for (const s of sentences) out.push(...split(s));
  // join adjacent *short sentences* (e.g. "Software stores only. US dollars only.") for calmer pacing
  return out.reduce((acc, c) => {
    const prev = acc[acc.length - 1];
    if (prev && /[.!?]["”']?$/.test(prev) && prev.length + c.length < 70) acc[acc.length - 1] = `${prev} ${c}`;
    else acc.push(c);
    return acc;
  }, []);
}

const sfx = (name) => log('sfx', { name });

/** Seconds into a narration line at which a phrase is spoken (by its position in the text). */
function atPhrase(id, phrase) {
  const text = lines[id].say;
  const i = text.indexOf(phrase);
  return i < 0 ? 0 : (i / text.length) * durations[id].duration;
}

/**
 * Show a PDF "file" being dragged by the cursor into the app's drop zone, then dispatch a
 * real drop event carrying the actual sample PDF, so the app's normal upload path runs.
 */
async function dragPdfIntoDropZone() {
  const zone = page.locator('div.border-dashed').first();
  await zone.scrollIntoViewIfNeeded();
  const box = await zone.boundingBox();
  const start = { x: 150, y: 600 };
  await page.evaluate(({ x, y }) => {
    const chip = document.createElement('div');
    chip.id = 'ig-file';
    chip.innerHTML = '<span style="background:#d03b3b;color:#fff;font:800 10px Inter,sans-serif;border-radius:4px;padding:3px 5px;letter-spacing:.04em">PDF</span><span>cloudscale-order-form.pdf</span>';
    Object.assign(chip.style, {
      position: 'fixed', left: '0', top: '0', zIndex: 2147483646, display: 'flex', alignItems: 'center', gap: '8px',
      padding: '9px 13px', borderRadius: '10px', background: '#1a1b21', border: '1px solid #4a4b55', color: '#ecedf1',
      font: '500 14px Inter, sans-serif', boxShadow: '0 14px 34px rgba(0,0,0,.55)', opacity: '0',
      transform: `translate(${x}px, ${y}px)`, transition: 'transform .9s cubic-bezier(.22,.8,.25,1), opacity .3s',
    });
    document.documentElement.appendChild(chip);
    requestAnimationFrame(() => (chip.style.opacity = '1'));
  }, start);
  await page.evaluate(({ x, y }) => window.__ig.cursor(true, x + 30, y + 14), start);
  await sleep(900);
  sfx('click');
  const target = { x: box.x + box.width / 2 - 110, y: box.y + box.height / 2 - 18 };
  await page.evaluate(({ x, y }) => {
    document.getElementById('ig-file').style.transform = `translate(${x}px, ${y}px) rotate(-2deg)`;
    window.__ig.cursor(true, x + 30, y + 14);
  }, target);
  await sleep(500);
  await zone.dispatchEvent('dragover', {});
  await sleep(600);
  await page.evaluate(async () => {
    const blob = await (await fetch('/samples/cloudscale-order-form.pdf')).blob();
    const file = new File([blob], 'cloudscale-order-form.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const zone = document.querySelector('div.border-dashed');
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const chip = document.getElementById('ig-file');
    chip.style.transition = 'opacity .35s, transform .35s';
    chip.style.opacity = '0';
    chip.style.transform += ' scale(.85)';
    setTimeout(() => chip.remove(), 400);
  });
}

async function cursorTo(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error('target not visible');
  const x = box.x + box.width / 2 - 4;
  const y = box.y + box.height / 2 - 4;
  await page.evaluate(({ x, y }) => window.__ig.cursor(true, x, y), { x, y });
  cursorPos = { x, y };
  await sleep(850);
}

async function clickOn(locator, { real = true } = {}) {
  await cursorTo(locator);
  await page.evaluate(({ x, y }) => window.__ig.ripple(x + 4, y + 4), cursorPos);
  sfx('click');
  await sleep(120);
  if (real) await locator.click();
}

async function cut(waitFor) {
  await page.evaluate(() => window.__ig?.cap('')).catch(() => {});
  log('cutStart');
  await waitFor();
  await sleep(500);
  log('cutEnd');
}

async function smoothScrollTo(locator, block = 'center') {
  await locator.evaluate((el, b) => el.scrollIntoView({ behavior: 'smooth', block: b }), block);
  await sleep(900);
}

async function fadeOut() {
  await page.evaluate(() => window.__ig?.fadeOut()).catch(() => {});
  await sleep(450);
}

async function slide(name) {
  await fadeOut();
  await page.goto(`file://${path.join(HERE, 'slides', `${name}.html`)}`);
  await page.evaluate(() => document.fonts.ready);
  await screencast();
  sfx('whoosh');
}

const btn = (name) => page.getByRole('button', { name }).first();
const mainText = (t) => page.getByRole('main').getByText(t).first();
const api = (p, body = {}) => fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// ---------------------------------------------------------------------------
// The film
// ---------------------------------------------------------------------------
await api('/api/reset');
await api('/api/contract/sample');

await page.goto(`file://${path.join(HERE, 'slides', 'title.html')}`);
await page.evaluate(() => document.fonts.ready);
await screencast();
await sleep(400);
log('start');
await sleep(1600);
await say('v01', { tail: 0.8 });

await slide('problem');
await sleep(500);
await say('v02', { tail: 0.8 });

await slide('split');
await sleep(500);
await say('v03', { tail: 0.8 });

// --- the live app ---
await fadeOut();
await page.goto(APP);
await mainText('Buy software without risking your cash').waitFor();
await screencast();
sfx('whoosh');
await page.evaluate(() => window.__ig.cursor(true, 760, 520));
await sleep(600);
const v04 = say('v04');
await sleep(4200);
await clickOn(btn(/Connect & set the rules/));
await mainText('Your rules are set').waitFor({ timeout: 60000 });
await v04;

// --- the contract itself, before it goes into the app ---
await page.evaluate(() => window.__ig.cursor(false));
await slide('contract');
await sleep(700);
{
  const v = say('v05a', { tail: 0.6 });
  const marks = [['Nine thousand', 'annual'], ['or one thousand', 'monthly'], ['clause four point five', 'fee']];
  for (const [phrase, key] of marks) {
    setTimeout(() => page.evaluate((k) => window.mark?.(k), key).catch(() => {}), atPhrase('v05a', phrase) * 1000);
  }
  await v;
}

// --- back to the app: drag the PDF into the drop zone (a real drop event) ---
await fadeOut();
await page.goto(APP);
await mainText('Your rules are set').waitFor();
await page.evaluate(() => window.__ig.cursor(true, 760, 520));
await sleep(500);
await clickOn(btn(/Next: the vendor/));
await mainText("Upload the vendor's offer").waitFor();
await sleep(500);
const v05b = say('v05b', { tail: 0.3 });
await dragPdfIntoDropZone();
await mainText(/cloudscale-order-form\.pdf/).waitFor({ timeout: 60000 });
await v05b;
await sleep(900);

await clickOn(btn(/Read the contract/));
await say('v06', { tail: 0.2 });
await cut(() => mainText(/, not |cheapest, and safe/).waitFor({ timeout: 240000 }));
await sleep(1200); // let the chart animate in

const v07 = say('v07');
await sleep(2800);
await smoothScrollTo(page.getByText('Your cash over the next 8 weeks').first(), 'start');
await v07;
const v08 = say('v08');
await clickOn(page.getByRole('button', { name: /See the contract and what Claude extracted/ }));
await sleep(400);
await clickOn(page.getByRole('button', { name: /view order form/ }));
await sleep(300);
// bring the document near the top, then scroll inside it so every highlight passes by
await page.locator('pre').first().evaluate((el) => {
  const top = el.getBoundingClientRect().top + window.scrollY - 120;
  window.scrollTo({ top, behavior: 'smooth' });
});
await sleep(1000);
await page.locator('pre').first().evaluate(async (el) => {
  const end = el.scrollHeight - el.clientHeight;
  const t0 = performance.now();
  await new Promise((res) => {
    const step = (t) => { const p = Math.min(1, (t - t0) / 5200); el.scrollTop = end * (0.5 - Math.cos(Math.PI * p) / 2); p < 1 ? requestAnimationFrame(step) : res(); };
    requestAnimationFrame(step);
  });
});
await v08;
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await sleep(700);

await clickOn(btn(/Approve \$1,000/));
await say('v09', { tail: 0.2 });
await cut(() => mainText('A card that can only pay').waitFor({ timeout: 120000 }));
sfx('chime');
await sleep(600);
await say('v10', { tail: 0.3 });

// technical details: intent fingerprint + Visa TAP credential
{
  const v = say('v10b', { tail: 0.3 });
  await clickOn(page.getByRole('button', { name: /Technical details: intent fingerprint/ }));
  await sleep(300);
  await smoothScrollTo(page.getByText('Trusted Agent Protocol credential').first(), 'start');
  await v;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(600);
}

const v11 = say('v11', { tail: 0.2 });
await sleep(5200);
await clickOn(btn(/Adds a \$250 fee/));
await v11;
await cut(() => mainText(/Overcharge blocked/).waitFor({ timeout: 240000 }));
sfx('alert');
await sleep(500);

const v12 = say('v12');
await sleep(3800);
await smoothScrollTo(page.getByText('Layers of protection, in order').first(), 'start');
await v12;
const v13 = say('v13');
await sleep(400);
const docsBlock = page.getByText(/What Airwallex's docs say/).first();
if (await docsBlock.count()) await smoothScrollTo(docsBlock, 'start');
await sleep(2600);
await smoothScrollTo(page.getByText('Incident report').first(), 'start');
await v13;
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await sleep(600);

await clickOn(btn(/Hold them to/));
await say('v14', { tail: 0.1 });
await cut(() => mainText(/Your cash is safe/).waitFor({ timeout: 240000 }));
sfx('success');
await sleep(500);
await say('v15', { tail: 0.3 });

// audit note + scheduled re-check
{
  const v = say('v15b', { tail: 0.3 });
  await sleep(300);
  await smoothScrollTo(page.getByText(/Next: week \d+ check-in/).first(), 'start');
  await sleep(1800);
  await smoothScrollTo(page.getByText('Audit note').first(), 'start');
  await v;
}

// refund through Airwallex
{
  const v = say('v15c', { tail: 0.3 });
  await smoothScrollTo(page.getByText('Need to undo it?').first(), 'center');
  await clickOn(btn(/Simulate a refund/));
  await mainText(/Refunded \$/).waitFor({ timeout: 60000 });
  sfx('chime');
  await v;
  await sleep(600);
}

await clickOn(btn(/See every API call/));
const v16 = say('v16');
await sleep(1200);
await page.evaluate(async () => {
  const box = [...document.querySelectorAll('aside .overflow-y-auto')].find((e) => e.scrollHeight > e.clientHeight);
  if (!box) return;
  box.scrollTop = 0;
  const end = box.scrollHeight - box.clientHeight;
  const t0 = performance.now();
  await new Promise((res) => {
    const step = (t) => { const p = Math.min(1, (t - t0) / 4800); box.scrollTop = end * (0.5 - Math.cos(Math.PI * p) / 2); p < 1 ? requestAnimationFrame(step) : res(); };
    requestAnimationFrame(step);
  });
});
await v16;

// state machine, then agent identity
{
  const v = say('v16b', { tail: 0.3 });
  await clickOn(page.getByRole('button', { name: 'State machine' }));
  await v;
  const w = say('v16c', { tail: 0.4 });
  await clickOn(page.getByRole('button', { name: 'Agent identity' }));
  await w;
}
await page.keyboard.press('Escape');
await page.evaluate(() => window.__ig.cursor(false));

await slide('layers');
await sleep(500);
await say('v17', { tail: 0.9 });

await slide('outro');
await sleep(500);
await say('v18', { tail: 0.4 });
await sleep(3200);
log('end');

await cdp.send('Page.stopScreencast');
await sleep(300);
writeFileSync(path.join(BUILD, 'timeline.json'), JSON.stringify({ frames, events }, null, 1));
await browser.close();
console.log(`frames: ${frames.length}, events: ${events.length}, raw length ${(events.at(-1).t - events[0].t).toFixed(1)}s`);
