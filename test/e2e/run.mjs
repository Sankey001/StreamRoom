// End-to-end tests: real StreamRoom app instances (1 host + 2 friends) on this PC, driven over the
// Chrome DevTools protocol, with fake camera/mic/screen. Each scenario is a connection edge case.
//   npm run test:e2e

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'streamroom-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 9400;
const apps = [];

async function launch(name) {
  const port = nextPort++;
  const proc = spawn(electron, [
    root,
    `--remote-debugging-port=${port}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--user-data-dir=${path.join(tmp, name)}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));
  let browser;
  for (let i = 0; i < 40 && !browser; i++) {
    await sleep(250);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 20000 }).catch(() => null);
  }
  if (!browser) throw new Error(`${name}: app did not start\n${log.join('')}`);
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().endsWith('index.html'));
    if (!page) await sleep(250);
  }
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  const a = { name, proc, browser, page, log };
  apps.push(a);
  return a;
}

async function kill(a) {
  a.browser.disconnect();
  a.proc.kill('SIGKILL');
  apps.splice(apps.indexOf(a), 1);
}

const ev = (a, fn, ...args) => a.page.evaluate(fn, ...args);
const snapshot = (a) => ev(a, () => {
  const { state } = window.streamroom;
  return {
    phase: state.phase,
    peerId: state.peerId,
    peers: [...state.peers.values()].map((p) => ({ name: p.name, away: !!p.away })),
    producers: [...state.producers.keys()],
    consumers: [...state.consumers.values()].map((c) => `${c.source}:${c.consumer.kind}`),
    banner: document.querySelector('#banner').hidden ? '' : document.querySelector('#banner').textContent,
    connecting: document.querySelector('#connecting').hidden ? '' : `${document.querySelector('#connTitle').textContent}: ${document.querySelector('#connSub').textContent}`,
    ended: document.querySelector('#ended').hidden ? '' : document.querySelector('#endTitle').textContent,
    retry: !document.querySelector('#retryBtn').hidden,
    homeError: document.querySelector('#homeError').textContent,
    quality: document.querySelector('#quality').textContent,
  };
});

async function waitFor(a, desc, pred, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await snapshot(a).catch(() => null);
    if (last && pred(last)) return last;
    await sleep(300);
  }
  throw new Error(`${a.name}: timed out waiting for ${desc}\n  last state: ${JSON.stringify(last)}`);
}

// Set to false when Chromium's fake test camera isn't available on this PC: media checks then use
// the fake microphones instead, so they still prove media flows end to end.
let cameras = true;
const mediaKind = () => (cameras ? 'video' : 'audio');
const peerMedia = (s) => s.consumers.filter((c) => (cameras ? c === 'cam:video' : c === 'mic:audio')).length;

/** Bytes received from other people, measured twice to prove media is flowing now. */
async function mediaFlowing(a) {
  const kind = mediaKind();
  const total = () => ev(a, async (k) => {
    let bytes = 0;
    for (const { consumer } of window.streamroom.state.consumers.values()) {
      if (consumer.kind !== k) continue;
      (await consumer.getStats()).forEach((s) => { if (s.type === 'inbound-rtp') bytes += s.bytesReceived || 0; });
    }
    return bytes;
  }, kind);
  const b1 = await total();
  await sleep(1500);
  return (await total()) - b1 > (kind === 'video' ? 10_000 : 1_000);
}

async function setName(a, name) {
  await a.page.$eval('#name', (el, v) => { el.value = v; }, name);
}

// DOM clicks, not synthetic mouse input: CDP mouse events can stall on a long-running Electron window.
const click = (a, sel) => a.page.$eval(sel, (el) => el.click());
const trace = (m) => process.env.TRACE && console.log(`    trace: ${m}`);

async function host(a) {
  if (process.env.TRACE) {
    const t0 = Date.now();
    const v = await a.browser.version().catch((e) => `browser HUNG ${e.message.slice(0, 30)}`);
    const r = await a.page.evaluate(() => ({ ok: 1, picker: !document.querySelector('#picker').hidden, conn: !document.querySelector('#connecting').hidden })).catch((e) => `page HUNG ${e.message.slice(0, 30)}`);
    trace(`${a.name} probes: browser=${v} page=${JSON.stringify(r)} in ${Date.now() - t0}ms`);
  }
  await ensureCamera(a);
  trace(`${a.name} set name`);
  await setName(a, a.name);
  trace(`${a.name} click start`);
  await click(a, '#startBtn');
  trace(`${a.name} wait for call`);
  await waitFor(a, 'call to start', (s) => s.phase === 'call');
  return a.page.$eval('#meetingId', (el) => el.textContent);
}

/**
 * Chromium's fake test camera sometimes isn't there for one of several app copies on the same PC
 * ("Requested device not found"). Ask again until the preview has video, so a flaky test device
 * doesn't show up as a call bug.
 */
async function ensureCamera(a) {
  if (!cameras) return;
  for (let i = 0; i < 6; i++) {
    const ok = await ev(a, () => !!document.querySelector('#preview').srcObject?.getVideoTracks().some((t) => t.readyState === 'live'));
    if (ok) return;
    if (i % 2 === 1) await ev(a, () => document.querySelector('#lobbyCam').dispatchEvent(new Event('change')));
    await sleep(700);
  }
  if (cameras) console.log(`    (fake test camera unavailable on this PC: checking media with the fake microphones instead)`);
  cameras = false;
}

async function join(a, code, typed = code) {
  await ensureCamera(a);
  await setName(a, a.name);
  await a.page.$eval('#codeInput', (el) => { el.value = ''; });
  await a.page.$eval('#codeInput', (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }, typed);
  await click(a, '#joinBtn');
}

const results = [];
async function scenario(title, fn) {
  const t0 = Date.now();
  process.stdout.write(`- ${title} ... `);
  try {
    await fn();
    results.push({ title, ok: true });
    console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ title, ok: false, err });
    for (const a of apps) {
      const tail = a.log.join('').split('\n').filter((l) => l.trim() && !/gpu|dxgi|angle/i.test(l)).slice(-8);
      console.log(`    --- ${a.name} app log ---\n      ${tail.join('\n      ')}`);
    }
    console.log(`FAILED\n    ${err.message.replace(/\n/g, '\n    ')}`);
  }
}

try {
  const H = await launch('Host');
  const A = await launch('Asha');
  const B = await launch('Bilal');
  let code;

  await scenario('host starts a meeting with one click and gets a short ID', async () => {
    code = await host(H);
    if (!/^[0-9A-Z]{3}-[0-9A-Z]{3}$/.test(code)) throw new Error(`unexpected ID ${code}`);
  });

  await scenario('joining shows the connecting screen; a wrong ID returns to start with a clear error', async () => {
    const wrong = code[0] === 'Z' ? `Y${code.slice(1)}` : `Z${code.slice(1)}`;
    await join(A, wrong);
    await waitFor(A, 'connecting screen', (s) => /Joining/i.test(s.connecting), 3000);
    await waitFor(A, 'error', (s) => /No meeting with this ID/.test(s.homeError) && !s.connecting, 12000);
    const audible = await ev(A, () => [...document.querySelectorAll('audio')].filter((a) => !a.muted && !a.paused).length);
    if (audible) throw new Error('audio playing outside a call');
  });

  await scenario('two friends join by ID (typed lowercase, no dash) and see each other', async () => {
    await join(A, code, code.replace('-', '').toLowerCase());
    await waitFor(A, 'joined', (s) => s.phase === 'call');
    await join(B, code);
    for (const x of [H, A, B]) await waitFor(x, '3 peers with media', (s) => s.peers.length === 3 && peerMedia(s) >= 2);
    for (const x of [H, A, B]) if (!(await mediaFlowing(x))) throw new Error(`${x.name}: no ${mediaKind()} flowing`);
  });

  await scenario('auto quality lowers cameras for a group of 3 (720p30)', async () => {
    await waitFor(H, '720p badge', (s) => /cam 720p30/.test(s.quality), 8000);
    if (!cameras) return; // the badge is checked; encodings need a camera
    const enc = await ev(A, () => window.streamroom.state.producers.get('cam').rtpSender.getParameters().encodings.map((e) => e.maxFramerate));
    if (enc.some((f) => f !== 30)) throw new Error(`camera encodings not capped to 30 fps: ${enc}`);
  });

  await scenario('signaling drop (Wi-Fi blip): friend reconnects with the same identity, nobody sees them leave', async () => {
    const before = await snapshot(A);
    let sawLeft = false;
    await ev(H, () => {
      window.__left = 0;
      window.streamroom.state.socket.on('peerLeft', () => { window.__left += 1; });
    });
    await ev(A, () => window.streamroom.state.socket.io.engine.close()); // kill the websocket under it
    await waitFor(H, 'friend shown as away', (s) => s.peers.some((p) => p.name === 'Asha' && p.away), 15000);
    const after = await waitFor(A, 'reconnected', (s) => s.phase === 'call' && !s.banner && !s.connecting && peerMedia(s) >= 2, 20000);
    if (after.peerId !== before.peerId) throw new Error('got a new identity instead of resuming');
    sawLeft = await ev(H, () => window.__left > 0);
    if (sawLeft) throw new Error('host saw the friend leave');
    await waitFor(H, 'friend back', (s) => s.peers.every((p) => !p.away));
    if (!(await mediaFlowing(A))) throw new Error('no media after reconnect');
    if (!(await mediaFlowing(H))) throw new Error('host lost the friend\'s video');
  });

  await scenario('media path failure: ICE restart recovers without rejoining', async () => {
    const before = await snapshot(B);
    await ev(B, () => window.streamroom.state.recvTransport.emit('connectionstatechange', 'failed'));
    await sleep(3000);
    const after = await snapshot(B);
    if (after.peerId !== before.peerId || after.phase !== 'call') throw new Error(`unexpected state ${JSON.stringify(after)}`);
    if (!(await mediaFlowing(B))) throw new Error('no media after ICE restart');
  });

  await scenario('a viewer reports slow internet: the sharer caps the screen at 720p, then recovers', async () => {
    await click(H, '#screenBtn');
    await waitFor(H, 'sharing', (s) => s.producers.includes('screen'));
    await waitFor(A, 'screen received', (s) => s.consumers.includes('screen:video'));
    await ev(B, () => window.streamroom.state.socket.emit('netStatus', { slow: true }));
    await waitFor(H, '720p cap', (s) => /screen 720p/.test(s.quality), 8000);
    const scale = await ev(H, () => window.streamroom.state.producers.get('screen').rtpSender.getParameters().encodings[0].scaleResolutionDownBy);
    if (Math.abs(scale - 1.5) > 0.01) throw new Error(`expected 1080/720 = 1.5 downscale, got ${scale}`);
    await ev(B, () => window.streamroom.state.socket.emit('netStatus', { slow: false }));
    await waitFor(H, 'back to 1080p', (s) => /screen 1080p/.test(s.quality), 8000);
  });

  await scenario('friend\'s app crashes: others see "reconnecting", then they leave after the grace period', async () => {
    await kill(B);
    await waitFor(H, 'Bilal away', (s) => s.peers.some((p) => p.name === 'Bilal' && p.away), 15000);
    await waitFor(H, 'Bilal gone', (s) => s.peers.length === 2, 30000);
    await waitFor(A, 'Bilal gone', (s) => s.peers.length === 2, 5000);
  });

  await scenario('friend leaves on purpose: removed immediately (no grace wait)', async () => {
    const C = await launch('Chen');
    await join(C, code);
    await waitFor(C, 'Chen in call', (s) => s.phase === 'call');
    await waitFor(H, 'Chen joined', (s) => s.peers.length === 3);
    await ev(C, () => { window.confirm = () => true; });
    await click(C, '#leaveBtn');
    await waitFor(H, 'Chen gone', (s) => s.peers.length === 2, 4000);
    await kill(C);
  });

  await scenario('host ends the meeting: friends get "meeting ended", not a reconnect loop', async () => {
    await ev(H, () => { window.confirm = () => true; });
    await click(H, '#leaveBtn');
    const s = await waitFor(A, 'ended screen', (x) => !!x.ended, 8000);
    if (!/ended/i.test(s.ended) || s.retry) throw new Error(`unexpected end screen ${JSON.stringify(s)}`);
  });

  await scenario('host app crashes mid-call: friend tries to reconnect, then says the host is gone', async () => {
    await H.page.waitForSelector('#home:not([hidden])');
    await click(A, '#homeBtn');
    await A.page.waitForSelector('#home:not([hidden])');
    const code2 = await host(H);
    await join(A, code2);
    await waitFor(A, 'joined', (s) => s.phase === 'call');
    await kill(H);
    await waitFor(A, 'reconnecting screen', (s) => /Reconnecting/i.test(s.connecting), 15000);
    const s = await waitFor(A, 'gave up', (x) => !!x.ended, 80000);
    if (!s.retry) throw new Error('expected a Try again button');
  });

  await scenario('after giving up, "Back to start" returns to a working start screen', async () => {
    await click(A, '#homeBtn');
    await A.page.waitForSelector('#home:not([hidden])', { timeout: 5000 });
    await waitFor(A, 'clean state', (s) => s.phase === 'home' && !s.banner && !s.ended && !s.connecting, 5000);
  });
} finally {
  for (const a of [...apps]) await kill(a).catch(() => {});
  await sleep(1000);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows still holds a cache file */ }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  process.exitCode = failed.length ? 1 : 0;
}
