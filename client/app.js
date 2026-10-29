import { Device } from 'mediasoup-client';
import { io } from 'socket.io-client';
import { makeCode, normalizeCode, formatCode } from './code.js';
import { AutoQuality, CAM_TIERS } from './quality.js';

const SCREEN_PRESETS = {
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000, hint: 'motion' },
  '1440p60': { width: 2560, height: 1440, fps: 60, bitrate: 14_000_000, hint: 'motion' },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 5_000_000, hint: 'detail' },
};
const CAM_CEILINGS = { '1080p60': 0, '720p30': 1 }; // index into CAM_TIERS
const RECONNECT_FOR_MS = 60_000;
const ICE_RESTARTS_BEFORE_REJOIN = 2;

const native = window.streamroomApp || null; // present when running inside the desktop app

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const state = {
  socket: null,
  device: null,
  sendTransport: null,
  recvTransport: null,
  peerId: null,
  maxPeers: 10,
  peers: new Map(), // peerId -> { id, name, away }
  producers: new Map(), // source -> Producer
  consumers: new Map(), // consumerId -> { consumer, peerId, source, layer, paused }
  tiles: new Map(), // tileId -> { root, video, peerId, kind, stats, consumerId }
  audioEls: new Map(), // consumerId -> <audio>
  // Local tracks outlive connections: after a reconnect they are simply published again.
  local: { mic: null, micMuted: false, cam: null, screen: null, screenAudio: null },
  meeting: null, // { code, url, isHost, token, name, ips, address }
  phase: 'home', // home | call | reconnecting | ended
  spotlight: null,
  statsOn: false,
  lastBytes: new Map(),
  unread: 0,
  settings: {},
};

const quality = new AutoQuality({
  people: () => state.peers.size,
  producer: (source) => state.producers.get(source),
  videoConsumers: () => [...state.consumers.values()].filter((c) => c.consumer.kind === 'video').map((c) => c.consumer),
  sendTransport: () => state.sendTransport,
  recvTransport: () => state.recvTransport,
  settings: () => state.settings,
  onChange: (info) => {
    renderQuality(info);
    if (info.recvChanged) layout();
  },
  onSlowDownChange: (slow) => {
    if (state.phase === 'call') request('netStatus', { slow }).catch(() => {});
  },
});

// ---------- home screen ----------

const params = new URLSearchParams(location.search);
$('#name').value = safeGet('sr-name') || '';
$('#codeInput').value = params.get('id') ? formatCode(normalizeCode(params.get('id')) || '') : '';
for (const id of ['screenPreset', 'camPreset', 'codec']) {
  const saved = safeGet(`sr-${id}`);
  if (saved && [...$(`#${id}`).options].some((o) => o.value === saved)) $(`#${id}`).value = saved;
}
$('#vpnHelp').hidden = !native;
$('#passwordField').hidden = !!native; // the desktop app's meetings are protected by the ID alone

// ---------- theme (the same four palettes as ytgrab) ----------

const THEMES = ['heritage', 'midnight', 'bordeaux', 'ivory'];
function applyTheme(key) {
  if (!THEMES.includes(key)) key = matchMedia('(prefers-color-scheme: light)').matches ? 'ivory' : 'heritage';
  document.documentElement.dataset.theme = key;
  for (const b of document.querySelectorAll('[data-theme-pick]')) b.setAttribute('aria-checked', String(b.dataset.themePick === key));
}
applyTheme(safeGet('sr-theme'));
for (const b of document.querySelectorAll('[data-theme-pick]')) {
  b.addEventListener('click', () => {
    safeSet('sr-theme', b.dataset.themePick);
    applyTheme(b.dataset.themePick);
  });
}

// ---------- connecting screen ----------
// Calm and silent: a slow gold ring, the steps so far, and no sound until you are in the call.

const NUMERALS = ['I', 'II', 'III', 'IV'];
const conn = {
  show({ title, code = '', steps, overCall = false }) {
    $('#connTitle').textContent = title;
    $('#connCode').textContent = code ? formatCode(code) : '';
    $('#connSub').textContent = '';
    $('#connSteps').replaceChildren(...steps.map((text, i) => {
      const li = el('li');
      li.append(el('span', 'numeral small', NUMERALS[i]), el('span', null, text));
      return li;
    }));
    $('#connecting').classList.toggle('over-call', overCall);
    $('#connCancel').textContent = overCall ? 'Leave meeting' : 'Cancel';
    $('#connecting').hidden = false;
  },
  step(index, sub = '') {
    [...$('#connSteps').children].forEach((li, i) => {
      li.classList.toggle('done', i < index);
      li.classList.toggle('active', i === index);
      li.querySelector('.numeral').textContent = i < index ? '✓' : NUMERALS[i];
    });
    if (sub) $('#connSub').textContent = sub;
  },
  hide() {
    $('#connecting').hidden = true;
  },
};
$('#connCancel').addEventListener('click', () => goHome());

function setRemoteAudio(on) {
  for (const a of state.audioEls.values()) a.muted = !on;
}

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* storage unavailable */ }
}

let previewStream = null;
let previewPending = Promise.resolve();
function startPreview() {
  previewPending = previewPending.then(openPreview, openPreview);
  return previewPending;
}
async function openPreview() {
  const wantCam = $('#lobbyCam').checked;
  const wantMic = $('#lobbyMic').checked;
  previewStream?.getTracks().forEach((t) => t.stop());
  previewStream = null;
  $('#preview').srcObject = null;
  $('#previewEmpty').textContent = 'Camera off';
  $('#previewEmpty').hidden = false;
  if (!wantCam && !wantMic) return;
  try {
    previewStream = await getMedia({
      video: wantCam ? camConstraints(CAM_TIERS[CAM_CEILINGS[$('#camPreset').value]], $('#camDevice').value) : false,
      audio: wantMic ? micConstraints($('#micDevice').value) : false,
    });
    if (wantCam && previewStream.getVideoTracks().length) {
      $('#preview').srcObject = previewStream;
      $('#previewEmpty').hidden = true;
    } else if (wantCam) {
      $('#previewEmpty').textContent = 'No camera found. You can still talk and share your screen.';
    }
    await fillDevices();
  } catch (err) {
    // Shown in the preview, not the error line, so it never hides why a join just failed.
    $('#previewEmpty').textContent = `Can't use your camera/mic (${err.message}). You can still join and share your screen.`;
  }
}

async function fillDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [kind, sel] of [['videoinput', '#camDevice'], ['audioinput', '#micDevice']]) {
    const select = $(sel);
    const current = select.value;
    select.replaceChildren(...devices.filter((d) => d.kind === kind).map((d, i) => {
      const o = el('option', null, d.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}`);
      o.value = d.deviceId;
      return o;
    }));
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  }
}

/**
 * getUserMedia that copes with missing hardware:
 *  - a remembered camera/mic that's gone (unplugged, new device ID) falls back to the default one;
 *  - asking for both, when one doesn't exist (a desktop with no webcam), still returns the other.
 */
async function getMedia(constraints) {
  const anyDevice = (c) => (c && typeof c === 'object' ? { ...c, deviceId: undefined } : c);
  const one = async (c) => {
    try {
      return await navigator.mediaDevices.getUserMedia(c);
    } catch (err) {
      if (err.name !== 'NotFoundError' && err.name !== 'OverconstrainedError') throw err;
      return navigator.mediaDevices.getUserMedia({ video: anyDevice(c.video), audio: anyDevice(c.audio) });
    }
  };
  if (!constraints.video || !constraints.audio) return one(constraints);
  try {
    return await one(constraints);
  } catch (bothErr) {
    const parts = await Promise.allSettled([one({ video: constraints.video }), one({ audio: constraints.audio })]);
    const tracks = parts.flatMap((p) => (p.status === 'fulfilled' ? p.value.getTracks() : []));
    if (!tracks.length) throw bothErr;
    return new MediaStream(tracks);
  }
}

function camConstraints(tier, deviceId) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    width: { ideal: Math.round((tier.height * 16) / 9) },
    height: { ideal: tier.height },
    frameRate: { ideal: tier.fps },
  };
}
function micConstraints(deviceId) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

function showHomeError(text) {
  $('#homeError').textContent = text;
}

function busy(on) {
  for (const b of ['#startBtn', '#joinBtn']) $(b).disabled = on;
}

for (const id of ['#lobbyCam', '#lobbyMic', '#camPreset', '#camDevice', '#micDevice']) {
  $(id).addEventListener('change', startPreview);
}
$('#codeInput').addEventListener('input', (e) => {
  // Format as you type: "k7p2qx" -> "K7P-2QX"
  const raw = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6);
  e.target.value = raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
});
$('#startBtn').addEventListener('click', () => run(startMeeting));
$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  run(joinMeeting);
});
if (!window.isSecureContext) showHomeError('This page is not on HTTPS, so the browser will block camera, mic and screen sharing.');
startPreview();

async function run(fn) {
  showHomeError('');
  try {
    await fn();
  } catch (err) {
    console.error(err);
    conn.hide();
    showHomeError(err.message);
    busy(false);
    if (state.meeting?.isHost) await native?.stopHosting().catch(() => {});
    state.meeting = null;
    disposeSession();
    for (const t of [state.local.mic, state.local.cam]) t?.stop();
    state.local.mic = null;
    state.local.cam = null;
    for (const [id] of [...state.tiles]) removeTile(id);
    state.peers.clear();
    state.peerId = null;
    startPreview();
  }
}

function readSettings() {
  const name = $('#name').value.trim() || 'Guest';
  safeSet('sr-name', name);
  for (const id of ['screenPreset', 'camPreset', 'codec']) safeSet(`sr-${id}`, $(`#${id}`).value);
  state.settings = {
    screenPreset: SCREEN_PRESETS[$('#screenPreset').value],
    camCeiling: CAM_CEILINGS[$('#camPreset').value],
    codec: $('#codec').value,
    camDevice: $('#camDevice').value,
    micDevice: $('#micDevice').value,
  };
  return name;
}

async function startMeeting() {
  const name = readSettings();
  busy(true);
  conn.show({ title: 'Starting meeting', steps: ['Opening the meeting room', 'Connecting', 'Turning on camera & mic'] });
  conn.step(0, 'Setting things up on this PC…');
  if (native) {
    const host = await native.startHosting();
    state.meeting = { code: host.code, url: `http://127.0.0.1:${host.port}`, isHost: true, name, ips: host.ips };
  } else {
    state.meeting = { code: makeCode(), url: location.origin, isHost: false, name, password: $('#passwordInput').value };
  }
  await enterCall();
}

async function joinMeeting() {
  const code = normalizeCode($('#codeInput').value);
  if (!code) throw new Error('Type the 6-character meeting ID your friend sent you, like K7P-2QX.');
  const name = readSettings();
  const address = $('#addressInput').value.trim();
  busy(true);
  conn.show({ title: 'Joining', code, steps: ['Finding the host', 'Connecting to the meeting', 'Turning on camera & mic'] });
  conn.step(0, address ? `Looking for the meeting at ${address}…` : 'Looking for the meeting on your network…');
  if (native) {
    const found = await native.findMeeting(code, address);
    state.meeting = { code, url: `http://${found.address}:${found.port}`, isHost: false, name, address };
  } else {
    state.meeting = { code, url: location.origin, isHost: false, name, password: $('#passwordInput').value };
  }
  await enterCall();
}

async function enterCall() {
  await previewPending; // don't race the home-screen preview for the camera
  const mic = previewStream?.getAudioTracks()[0];
  const cam = previewStream?.getVideoTracks()[0];
  previewStream = null;
  state.local.mic = $('#lobbyMic').checked ? mic || null : null;
  state.local.cam = $('#lobbyCam').checked ? cam || null : null;
  if (!state.local.cam) cam?.stop();
  watchLocalTrack('mic');
  watchLocalTrack('cam');

  conn.step(1, 'Connecting to the host…');
  await connectSession(() => conn.step(2, 'Almost there…'));

  if (!native) history.replaceState(null, '', `?id=${state.meeting.code}`);
  $('#meetingId').textContent = formatCode(state.meeting.code);
  $('#hostBadge').hidden = !state.meeting.isHost;
  $('#home').hidden = true;
  $('#call').hidden = false;
  state.phase = 'call';
  setRemoteAudio(true);
  conn.hide();
  quality.start();
  refreshButtons();
  layout();
  busy(false);
}

// ---------- connection ----------

function request(event, data = {}) {
  if (!state.socket?.connected) return Promise.reject(new Error('Not connected'));
  return state.socket.timeout(10_000).emitWithAck(event, data).then((res) => {
    if (res?.error) throw new Error(res.error);
    return res;
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'], reconnection: false, timeout: 5000, forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', () => {
      socket.close();
      reject(new Error('Could not reach the meeting host'));
    });
  });
}

/** One full signaling + media session. Called on first join and after every reconnect. */
async function connectSession(onMediaStep) {
  const socket = await openSocket(state.meeting.url);
  state.socket = socket;
  bindSocket(socket);

  const res = await request('join', {
    roomId: state.meeting.code.toLowerCase(), name: state.meeting.name, token: state.meeting.token, password: state.meeting.password,
  });
  state.meeting.token = res.token;
  if (state.peerId && state.peerId !== res.peerId) {
    // Came back after the grace period: the server gave us a new identity.
    for (const [id, tile] of [...state.tiles]) if (tile.peerId === state.peerId) removeTile(id);
    state.peers.delete(state.peerId);
  }
  state.peerId = res.peerId;
  state.maxPeers = res.maxPeers;
  state.peers.set(res.peerId, { id: res.peerId, name: `${res.name} (you)`, away: false });
  for (const p of res.peers) state.peers.set(p.id, p);

  state.device = new Device();
  await state.device.load({ routerRtpCapabilities: res.routerRtpCapabilities });
  state.sendTransport = await createTransport('send');
  state.recvTransport = await createTransport('recv');

  for (const p of state.peers.values()) {
    const tile = ensureTile(p.id, 'cam');
    tile.root.classList.toggle('away', !!p.away);
  }
  updateCount();
  await request('ready', { rtpCapabilities: state.device.rtpCapabilities });

  onMediaStep?.();
  await publishLocal();
  quality.reset();
  quality.setSlowViewers(res.slowViewers.length);
  if (quality.slowDown.on) request('netStatus', { slow: true }).catch(() => {});
}

/** Forget everything about the current connection; local tracks are kept. */
function disposeSession() {
  const socket = state.socket;
  state.socket = null;
  if (socket) {
    socket.removeAllListeners();
    socket.close();
  }
  for (const id of [...state.consumers.keys()]) closeConsumer(id, true);
  for (const p of state.producers.values()) p.close();
  state.producers.clear();
  state.sendTransport?.close();
  state.recvTransport?.close();
  state.sendTransport = null;
  state.recvTransport = null;
  for (const [id, tile] of [...state.tiles]) if (tile.peerId !== state.peerId) removeTile(id);
  state.peers = new Map([...state.peers].filter(([id]) => id === state.peerId));
  state.lastBytes.clear();
}

async function createTransport(direction) {
  const p = await request('createTransport', { direction });
  const opts = { id: p.id, iceParameters: p.iceParameters, iceCandidates: p.iceCandidates, dtlsParameters: p.dtlsParameters };
  const transport = direction === 'send' ? state.device.createSendTransport(opts) : state.device.createRecvTransport(opts);

  transport.on('connect', ({ dtlsParameters }, ok, fail) => {
    request('connectTransport', { transportId: transport.id, dtlsParameters }).then(() => ok(), fail);
  });
  if (direction === 'send') {
    transport.on('produce', ({ kind, rtpParameters, appData }, ok, fail) => {
      request('produce', { transportId: transport.id, kind, rtpParameters, appData }).then(({ id }) => ok({ id }), fail);
    });
  }
  watchTransport(transport, direction);
  return transport;
}

/**
 * Media path recovery. "disconnected" often heals by itself (brief Wi-Fi blip); if not, restart ICE
 * (new network path, same session). If that keeps failing, rejoin from scratch.
 */
function watchTransport(transport, direction) {
  let restarts = 0;
  let timer = null;
  const restart = async () => {
    if (transport.closed || state.phase !== 'call') return;
    if (restarts >= ICE_RESTARTS_BEFORE_REJOIN) return reconnect(`media connection (${direction}) failed`);
    restarts += 1;
    try {
      const { iceParameters } = await request('restartIce', { transportId: transport.id });
      await transport.restartIce({ iceParameters });
    } catch (err) {
      console.warn('ICE restart failed:', err.message);
    }
  };
  transport.on('connectionstatechange', (s) => {
    clearTimeout(timer);
    if (s === 'connected') {
      restarts = 0;
      if (state.phase === 'call') hideBanner();
    } else if (s === 'disconnected') {
      showBanner('Connection unstable…');
      timer = setTimeout(restart, 4000);
    } else if (s === 'failed') {
      showBanner('Reconnecting media…');
      restart();
    }
  });
}

let reconnecting = null;
/** Signaling dropped (or media gave up): keep trying for a minute, re-finding the host if it moved. */
function reconnect(reason) {
  if (reconnecting || state.phase === 'ended' || state.phase === 'home') return reconnecting;
  console.warn('reconnecting:', reason);
  state.phase = 'reconnecting';
  quality.stop();
  disposeSession();
  layout();
  hideBanner();
  // Most blips heal in well under a second; only cover the call if this takes a moment.
  const steps = ['Waiting for the network', 'Finding the host again', 'Rejoining the meeting'];
  let lastStep = [1, 'The connection dropped. Getting you back in…'];
  const showTimer = setTimeout(() => {
    conn.show({ title: 'Reconnecting', code: state.meeting.code, overCall: true, steps });
    conn.step(...lastStep);
  }, 800);
  const step = (i, sub) => {
    lastStep = [i, sub];
    conn.step(i, sub);
  };
  reconnecting = (async () => {
    const deadline = Date.now() + RECONNECT_FOR_MS;
    for (let attempt = 1; Date.now() < deadline && state.phase === 'reconnecting'; attempt++) {
      if (!navigator.onLine) step(0, 'You are offline. This continues by itself when the network is back.');
      else {
        try {
          step(1, attempt === 1 ? 'The connection dropped. Getting you back in…' : `Still trying (attempt ${attempt})…`);
          // The host may have come back on a different address (Wi-Fi reconnect): look it up again.
          if (native && !state.meeting.isHost && attempt % 2 === 0) {
            const found = await native.findMeeting(state.meeting.code, state.meeting.address);
            state.meeting.url = `http://${found.address}:${found.port}`;
          }
          await connectSession(() => step(2, 'Rejoining…'));
          if (state.phase !== 'reconnecting') return; // left or ended while we were connecting
          state.phase = 'call';
          setRemoteAudio(true);
          conn.hide();
          quality.start();
          refreshButtons();
          layout();
          toast('Reconnected');
          return;
        } catch (err) {
          console.warn(`reconnect attempt ${attempt} failed:`, err.message);
          disposeSession();
        }
      }
      await waitForRetry(Math.min(1000 * attempt, 5000));
    }
    if (state.phase === 'reconnecting') {
      endScreen('Lost connection to the meeting', state.meeting.isHost
        ? 'Your network went away for too long.'
        : 'The host may have left, or your network is down.', true);
    }
  })().finally(() => {
    clearTimeout(showTimer);
    reconnecting = null;
  });
  return reconnecting;
}

/** Sleep, but wake up early when the network comes back. */
function waitForRetry(ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      window.removeEventListener('online', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    window.addEventListener('online', done);
  });
}

window.addEventListener('offline', () => {
  if (state.phase === 'call') showBanner('You are offline. Waiting for the network…');
});

function bindSocket(socket) {
  socket.on('peerJoined', (p) => {
    state.peers.set(p.id, { ...p, away: false });
    ensureTile(p.id, 'cam');
    toast(`${p.name} joined`);
    peopleChanged();
  });

  socket.on('peerLeft', ({ id }) => {
    const p = state.peers.get(id);
    for (const [cid, c] of state.consumers) if (c.peerId === id) closeConsumer(cid);
    removeTile(`${id}:cam`);
    removeTile(`${id}:screen`);
    state.peers.delete(id);
    if (p) toast(`${p.name} left`);
    peopleChanged();
  });

  socket.on('peerAway', ({ id }) => {
    const p = state.peers.get(id);
    if (!p) return;
    p.away = true;
    state.tiles.get(`${id}:cam`)?.root.classList.add('away');
  });

  socket.on('peerBack', ({ id }) => {
    const p = state.peers.get(id);
    if (!p) return;
    p.away = false;
    state.tiles.get(`${id}:cam`)?.root.classList.remove('away');
  });

  socket.on('slowViewers', ({ ids }) => quality.setSlowViewers(ids.filter((id) => id !== state.peerId).length));

  socket.on('newConsumer', async (data, ack) => {
    try {
      const consumer = await state.recvTransport.consume({
        id: data.id,
        producerId: data.producerId,
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: { peerId: data.peerId, source: data.source },
      });
      const entry = { consumer, peerId: data.peerId, source: data.source, layer: 2, paused: data.producerPaused };
      state.consumers.set(consumer.id, entry);
      attachConsumer(entry);
      ack({ ok: true });
    } catch (err) {
      console.error('consume failed', err);
      ack({ error: err.message });
    }
  });

  socket.on('consumerClosed', ({ consumerId }) => closeConsumer(consumerId));
  socket.on('consumerPaused', ({ consumerId }) => setConsumerPaused(consumerId, true));
  socket.on('consumerResumed', ({ consumerId }) => setConsumerPaused(consumerId, false));

  socket.on('activeSpeaker', ({ peerId }) => {
    for (const t of state.tiles.values()) t.root.classList.toggle('speaking', t.kind === 'cam' && t.peerId === peerId);
  });

  socket.on('chat', addChat);

  socket.on('meetingEnded', () => {
    endScreen('The meeting has ended', 'The host closed the meeting.', false);
  });

  socket.on('disconnect', () => {
    if (state.socket !== socket) return;
    if (state.phase === 'call') reconnect('signaling disconnected');
  });
}

function peopleChanged() {
  updateCount();
  layout();
  quality.apply();
}

function endScreen(title, text, canRetry) {
  state.phase = 'ended';
  quality.stop();
  disposeSession();
  hideBanner();
  conn.hide();
  $('#endTitle').textContent = title;
  $('#endText').textContent = text;
  $('#retryBtn').hidden = !canRetry;
  $('#ended').hidden = false;
}

// ---------- local media ----------

function report(err) {
  console.error(err);
  if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') toast(err.message || String(err), 6000);
}

/** A device unplugged mid-call ends its track: drop it cleanly instead of sending black/silence. */
function watchLocalTrack(kind) {
  const track = state.local[kind];
  if (!track) return;
  track.addEventListener('ended', () => {
    if (state.local[kind] !== track) return;
    state.local[kind] = null;
    stopProducer(kind);
    toast(kind === 'mic' ? 'Microphone disconnected' : 'Camera disconnected', 4000);
    refreshButtons();
  });
}

async function publishLocal() {
  if (state.local.mic?.readyState === 'live') await produceMic().catch(report);
  if (state.local.cam?.readyState === 'live') await produceCam().catch(report);
  if (state.local.screen?.readyState === 'live') await produceScreen().catch(report);
}

async function produceMic() {
  const producer = await state.sendTransport.produce({
    track: state.local.mic,
    codecOptions: { opusStereo: false, opusDtx: true, opusFec: true },
    appData: { source: 'mic' },
    stopTracks: false, // we own the track; reconnects reuse it
  });
  state.producers.set('mic', producer);
  if (state.local.micMuted) {
    producer.pause();
    await request('pauseProducer', { producerId: producer.id });
  }
}

async function toggleMic() {
  if (!state.local.mic) {
    state.local.mic = (await getMedia({ audio: micConstraints(state.settings.micDevice) })).getAudioTracks()[0];
    state.local.micMuted = false;
    watchLocalTrack('mic');
    if (state.phase === 'call') await produceMic();
    return refreshButtons();
  }
  state.local.micMuted = !state.local.micMuted;
  const producer = state.producers.get('mic');
  if (producer) {
    if (state.local.micMuted) producer.pause();
    else producer.resume();
    await request(state.local.micMuted ? 'pauseProducer' : 'resumeProducer', { producerId: producer.id }).catch(() => {});
  }
  refreshButtons();
}

async function produceCam() {
  const top = CAM_TIERS[0].bitrate;
  const producer = await state.sendTransport.produce({
    track: state.local.cam,
    codec: findCodec('VP8'),
    // Three simulcast layers: the server forwards whichever one each viewer's tile size and bandwidth allow.
    encodings: [
      { scaleResolutionDownBy: 4, maxBitrate: Math.round(top * 0.07), scalabilityMode: 'L1T3' },
      { scaleResolutionDownBy: 2, maxBitrate: Math.round(top * 0.25), scalabilityMode: 'L1T3' },
      { scaleResolutionDownBy: 1, maxBitrate: top, scalabilityMode: 'L1T3' },
    ],
    codecOptions: { videoGoogleStartBitrate: 1500 },
    appData: { source: 'cam' },
    stopTracks: false,
  });
  state.producers.set('cam', producer);
  setTileVideo(ensureTile(state.peerId, 'cam'), state.local.cam, true);
  await quality.apply();
}

async function toggleCam() {
  if (state.local.cam) {
    const track = state.local.cam;
    state.local.cam = null;
    await stopProducer('cam');
    track.stop(); // turns the camera light off
  } else {
    const tier = CAM_TIERS[state.settings.camCeiling];
    state.local.cam = (await getMedia({ video: camConstraints(tier, state.settings.camDevice) })).getVideoTracks()[0];
    watchLocalTrack('cam');
    if (state.phase === 'call') await produceCam();
  }
  refreshButtons();
}

async function startScreen() {
  const preset = state.settings.screenPreset;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps },
    },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    selfBrowserSurface: 'exclude',
    systemAudio: 'include',
    surfaceSwitching: 'include',
  });
  const track = stream.getVideoTracks()[0];
  if ('contentHint' in track) track.contentHint = preset.hint;
  state.local.screen = track;
  state.local.screenAudio = stream.getAudioTracks()[0] || null;
  track.addEventListener('ended', () => stopScreen().finally(refreshButtons));
  await produceScreen();
  layout();
}

async function produceScreen() {
  const preset = state.settings.screenPreset;
  const pref = state.settings.codec;
  const codec = pref === 'auto' ? findCodec('H264') || findCodec('VP8') : findCodec(pref) || findCodec('VP8');
  const producer = await state.sendTransport.produce({
    track: state.local.screen,
    codec,
    // A single layer, not simulcast: Chrome only uses the GPU's H.264 encoder for single-layer
    // streams, and software encoding can't hold 1080p60.
    encodings: [{ maxBitrate: preset.bitrate, maxFramerate: preset.fps }],
    codecOptions: { videoGoogleStartBitrate: 2500 },
    appData: { source: 'screen' },
    stopTracks: false,
  });
  state.producers.set('screen', producer);
  setTileVideo(ensureTile(state.peerId, 'screen'), state.local.screen, false);
  await setDegradation(producer, preset.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution');
  await quality.apply();

  if (state.local.screenAudio?.readyState === 'live') {
    const audioProducer = await state.sendTransport.produce({
      track: state.local.screenAudio,
      codecOptions: { opusStereo: true, opusDtx: false, opusFec: true, opusMaxAverageBitrate: 128_000 },
      appData: { source: 'screen-audio' },
      stopTracks: false,
    });
    state.producers.set('screen-audio', audioProducer);
  }
}

async function setDegradation(producer, preference) {
  const sender = producer.rtpSender;
  if (!sender) return;
  try {
    const p = sender.getParameters();
    p.degradationPreference = preference;
    await sender.setParameters(p);
  } catch { /* not supported in this browser */ }
}

async function stopScreen() {
  state.local.screen?.stop();
  state.local.screenAudio?.stop();
  state.local.screen = null;
  state.local.screenAudio = null;
  await stopProducer('screen-audio');
  await stopProducer('screen');
  removeTile(`${state.peerId}:screen`);
  layout();
}

async function toggleScreen() {
  if (state.local.screen) await stopScreen();
  else await startScreen().catch(report);
  refreshButtons();
}

async function stopProducer(source) {
  if (source === 'cam') setTileVideo(state.tiles.get(`${state.peerId}:cam`), null);
  const producer = state.producers.get(source);
  if (!producer) return;
  state.producers.delete(source);
  producer.close();
  await request('closeProducer', { producerId: producer.id }).catch(() => {});
}

function findCodec(name) {
  const mime = `video/${name}`.toLowerCase();
  return state.device.rtpCapabilities.codecs.find((c) => c.mimeType.toLowerCase() === mime);
}

// ---------- screen picker (desktop app) ----------

native?.onPickScreen(({ id, sources }) => {
  const grid = $('#pickerGrid');
  const finish = (choice) => {
    $('#picker').hidden = true;
    grid.replaceChildren();
    native.screenPicked(id, choice);
  };
  grid.replaceChildren(...sources.map((s) => {
    const b = el('button', 'source');
    b.type = 'button';
    const img = el('img');
    img.alt = '';
    if (s.thumb) img.src = s.thumb;
    b.append(img, el('span', null, s.screen ? `🖥️ ${s.name}` : s.name));
    b.addEventListener('click', () => finish({ id: s.id, audio: $('#pickerAudio').checked }));
    return b;
  }));
  $('#pickerCancel').onclick = () => finish(null);
  $('#picker').hidden = false;
});

// ---------- remote media ----------

function attachConsumer(entry) {
  const { consumer, peerId, source } = entry;
  if (consumer.kind === 'audio') {
    const audio = el('audio');
    audio.autoplay = true;
    audio.muted = state.phase !== 'call'; // the connecting screen stays silent
    audio.srcObject = new MediaStream([consumer.track]);
    $('#audio').append(audio);
    audio.play().catch(() => {});
    state.audioEls.set(consumer.id, audio);
    if (source === 'mic') setMicIndicator(peerId, entry.paused);
    return;
  }
  const tile = ensureTile(peerId, source === 'screen' ? 'screen' : 'cam');
  tile.consumerId = consumer.id;
  setTileVideo(tile, consumer.track, false);
  layout();
}

function closeConsumer(consumerId, quiet = false) {
  const entry = state.consumers.get(consumerId);
  if (!entry) return;
  state.consumers.delete(consumerId);
  entry.consumer.close();
  state.lastBytes.delete(consumerId);
  const audio = state.audioEls.get(consumerId);
  if (audio) {
    audio.srcObject = null;
    audio.remove();
    state.audioEls.delete(consumerId);
  }
  if (entry.source === 'screen') removeTile(`${entry.peerId}:screen`);
  if (entry.source === 'cam') setTileVideo(state.tiles.get(`${entry.peerId}:cam`), null);
  if (entry.source === 'mic') setMicIndicator(entry.peerId, true);
  if (!quiet) layout();
}

function setConsumerPaused(consumerId, paused) {
  const entry = state.consumers.get(consumerId);
  if (!entry) return;
  entry.paused = paused;
  if (entry.source === 'mic') setMicIndicator(entry.peerId, paused);
}

// ---------- tiles & layout ----------

function ensureTile(peerId, kind) {
  const id = `${peerId}:${kind}`;
  let tile = state.tiles.get(id);
  if (tile) return tile;

  const root = el('div', `tile ${kind}`);
  root.dataset.id = id;
  const video = el('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true; // audio plays through separate <audio> elements
  const name = state.peers.get(peerId)?.name || 'Guest';
  const avatar = el('div', 'avatar', name.trim().charAt(0).toUpperCase() || '?');
  const label = el('div', 'label');
  const mic = el('span', 'mic-off', '🔇');
  mic.title = 'Muted';
  mic.hidden = kind !== 'cam';
  label.append(mic, el('span', 'name', kind === 'screen' ? `${name} · screen` : name), el('span', 'away-note', 'reconnecting…'));
  const stats = el('div', 'stats');
  stats.hidden = !state.statsOn;
  const full = el('button', 'fullscreen', '⛶');
  full.title = 'Fullscreen';
  full.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen?.();
  });
  root.append(video, avatar, label, stats, full);
  root.addEventListener('click', () => {
    state.spotlight = state.spotlight === id ? null : id;
    layout();
  });
  if (kind === 'cam' && peerId !== state.peerId) root.classList.add('muted');

  tile = { root, video, peerId, kind, stats, consumerId: null };
  state.tiles.set(id, tile);
  $('#grid').append(root);
  return tile;
}

function setTileVideo(tile, track, mirror) {
  if (!tile) return;
  tile.video.srcObject = track ? new MediaStream([track]) : null;
  tile.root.classList.toggle('has-video', !!track);
  tile.root.classList.toggle('mirror', !!mirror);
  if (track) tile.video.play().catch(() => {});
  else tile.consumerId = null;
}

function setMicIndicator(peerId, muted) {
  state.tiles.get(`${peerId}:cam`)?.root.classList.toggle('muted', muted);
}

function removeTile(id) {
  const tile = state.tiles.get(id);
  if (!tile) return;
  tile.video.srcObject = null;
  tile.root.remove();
  state.tiles.delete(id);
  if (state.spotlight === id) state.spotlight = null;
}

function layout() {
  if (state.spotlight && !state.tiles.has(state.spotlight)) state.spotlight = null;
  // Auto-spotlight someone else's screen share; your own preview stays small.
  const stageId = state.spotlight
    || [...state.tiles.keys()].find((id) => id.endsWith(':screen') && !id.startsWith(`${state.peerId}:`))
    || null;

  const stage = $('#stage');
  const grid = $('#grid');
  for (const [id, tile] of state.tiles) {
    const target = id === stageId ? stage : grid;
    if (tile.root.parentElement !== target) {
      target.append(tile.root);
      if (tile.video.srcObject) tile.video.play().catch(() => {});
    }
    tile.root.classList.toggle('on-stage', id === stageId);
  }
  $('#view').classList.toggle('has-stage', !!stageId);
  const n = grid.children.length;
  grid.style.setProperty('--cols', String(stageId ? 1 : Math.max(1, Math.ceil(Math.sqrt(n)))));
  grid.style.setProperty('--rows', String(stageId ? n : Math.max(1, Math.ceil(n / Math.ceil(Math.sqrt(n))))));
  updateLayers(stageId, n);
}

// Pick a simulcast layer per remote camera from its tile size, capped when this PC/network is struggling.
function updateLayers(stageId, gridCount) {
  if (!state.socket?.connected) return;
  const cap = quality.maxRecvLayer;
  for (const [cid, entry] of state.consumers) {
    if (entry.source !== 'cam') continue; // screen shares are a single full-quality layer
    let layer;
    if (`${entry.peerId}:cam` === stageId) layer = 2;
    else if (stageId || gridCount > 6) layer = 0;
    else if (gridCount > 2) layer = 1;
    else layer = 2;
    layer = Math.min(layer, cap);
    if (layer !== entry.layer) {
      entry.layer = layer;
      request('setConsumerLayers', { consumerId: cid, spatialLayer: layer }).catch(() => {});
    }
  }
}

function updateCount() {
  $('#count').textContent = `${state.peers.size}/${state.maxPeers}`;
}

function renderQuality(info) {
  const badge = $('#quality');
  const sharing = !!state.producers.get('screen');
  badge.textContent = info.slow
    ? `Slow internet · max 720p`
    : `Auto · cam ${info.cam}${sharing ? ` · screen ${info.screen}` : ''}`;
  badge.classList.toggle('warn', !!info.reason);
  badge.title = info.reason
    ? `Quality lowered: ${info.reason}. It goes back up by itself once things settle.`
    : `Quality adjusts automatically to ${info.people} ${info.people === 1 ? 'person' : 'people'}, your network and your PC.`;
}

// ---------- stats overlay ----------

async function collectStats() {
  if (!state.statsOn) return;
  for (const tile of state.tiles.values()) {
    const source = tile.peerId === state.peerId
      ? state.producers.get(tile.kind)
      : tile.consumerId && state.consumers.get(tile.consumerId)?.consumer;
    if (!source || source.closed || !tile.video.srcObject) {
      tile.stats.textContent = '';
      continue;
    }
    try {
      const report = await source.getStats();
      const rtp = [];
      const codecs = new Map();
      report.forEach((s) => {
        if ((s.type === 'inbound-rtp' || s.type === 'outbound-rtp') && s.kind === 'video') rtp.push(s);
        if (s.type === 'codec') codecs.set(s.id, s.mimeType);
      });
      if (!rtp.length) continue;
      const best = rtp.reduce((a, b) => ((b.frameWidth || 0) > (a.frameWidth || 0) ? b : a));
      const bytes = rtp.reduce((sum, s) => sum + (s.bytesReceived ?? s.bytesSent ?? 0), 0);
      const key = source.id;
      const prev = state.lastBytes.get(key);
      const now = performance.now();
      state.lastBytes.set(key, { bytes, t: now });
      const mbps = prev ? ((bytes - prev.bytes) * 8) / ((now - prev.t) / 1000) / 1e6 : 0;
      const codec = (codecs.get(best.codecId) || '').replace('video/', '');
      const fps = Math.round(best.framesPerSecond || 0);
      const res = best.frameWidth ? `${best.frameWidth}×${best.frameHeight}` : '—';
      const limit = best.qualityLimitationReason && best.qualityLimitationReason !== 'none' ? ` · limited: ${best.qualityLimitationReason}` : '';
      tile.stats.textContent = `${res} @ ${fps}fps · ${mbps.toFixed(1)} Mbps · ${codec}${limit}`;
    } catch { /* consumer closed mid-read */ }
  }
}
setInterval(collectStats, 1000);

// ---------- chat ----------

function addChat({ peerId, name, text, ts }) {
  const mine = peerId === state.peerId;
  const item = el('div', `msg${mine ? ' mine' : ''}`);
  const meta = el('div', 'meta', `${mine ? 'You' : name} · ${new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  item.append(meta, el('div', 'text', text));
  const list = $('#messages');
  list.append(item);
  list.scrollTop = list.scrollHeight;
  if ($('#chat').hidden && !mine) {
    state.unread += 1;
    $('#unread').textContent = String(state.unread);
    $('#unread').hidden = false;
  }
}

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  request('chat', { text }).then(() => { $('#chatInput').value = ''; }, report);
});

// ---------- controls ----------

function refreshButtons() {
  const micOn = !!state.local.mic && !state.local.micMuted;
  $('#micBtn').classList.toggle('off', !micOn);
  $('#micBtn').querySelector('.ico').textContent = micOn ? '🎙️' : '🔇';
  $('#micBtn').title = micOn ? 'Mute (M)' : 'Unmute (M)';
  setMicIndicator(state.peerId, !micOn);

  const camOn = !!state.local.cam;
  $('#camBtn').classList.toggle('off', !camOn);
  $('#camBtn').title = camOn ? 'Turn camera off (V)' : 'Turn camera on (V)';
  if (!camOn) setTileVideo(state.tiles.get(`${state.peerId}:cam`), null);

  const sharing = !!state.local.screen;
  $('#screenBtn').classList.toggle('active', sharing);
  $('#screenBtn').querySelector('.txt').textContent = sharing ? 'Stop sharing' : 'Share screen';
}

$('#micBtn').addEventListener('click', () => toggleMic().catch(report));
$('#camBtn').addEventListener('click', () => toggleCam().catch(report));
$('#screenBtn').addEventListener('click', () => toggleScreen());
$('#statsBtn').addEventListener('click', () => {
  state.statsOn = !state.statsOn;
  $('#statsBtn').classList.toggle('active', state.statsOn);
  for (const t of state.tiles.values()) t.stats.hidden = !state.statsOn;
  collectStats();
});
$('#chatBtn').addEventListener('click', () => {
  $('#chat').hidden = !$('#chat').hidden;
  if (!$('#chat').hidden) {
    state.unread = 0;
    $('#unread').hidden = true;
    $('#chatInput').focus();
  }
});
$('#copyIdBtn').addEventListener('click', async () => {
  const text = inviteText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Invite copied. Paste it to your friends.');
  } catch {
    prompt('Copy this and send it to your friends:', text);
  }
});
$('#leaveBtn').addEventListener('click', () => leave());
$('#retryBtn').addEventListener('click', () => {
  $('#ended').hidden = true;
  state.phase = 'call';
  reconnect('manual retry');
});
$('#homeBtn').addEventListener('click', () => goHome());

function inviteText() {
  const { code, ips = [] } = state.meeting;
  const lines = [`Join my StreamRoom meeting. Meeting ID: ${formatCode(code)}`];
  if (!native) lines.push(`${location.origin}/?id=${code}`);
  // VPN adapters (Tailscale 100.x, Radmin 26.x, ZeroTier, ...) can't be found by ID alone.
  const vpn = ips.filter((ip) => !/^(192\.168|10)\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  if (vpn.length) lines.push(`Not on my Wi-Fi? Click "Joining from another network?" and enter: ${vpn[0]}`);
  return lines.join('\n');
}

document.addEventListener('keydown', (e) => {
  if (state.phase !== 'call' || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'm') toggleMic().catch(report);
  if (e.key === 'v') toggleCam().catch(report);
});

async function leave() {
  if (state.meeting?.isHost && state.peers.size > 1 && !confirm('You are hosting. Leaving ends the meeting for everyone. Leave?')) return;
  await request('leave').catch(() => {});
  goHome();
}

async function goHome() {
  state.phase = 'home';
  quality.stop();
  disposeSession();
  for (const t of [state.local.mic, state.local.cam, state.local.screen, state.local.screenAudio]) t?.stop();
  if (state.meeting?.isHost) await native?.stopHosting().catch(() => {});
  location.reload(); // fresh start (a reload, because the app blocks navigating elsewhere)
}

window.addEventListener('beforeunload', () => {
  if (state.phase === 'call' && state.socket?.connected) state.socket.emit('leave');
});

let bannerShown = false;
function showBanner(text) {
  bannerShown = true;
  $('#banner').textContent = text;
  $('#banner').hidden = false;
}
function hideBanner() {
  if (!bannerShown) return;
  bannerShown = false;
  $('#banner').hidden = true;
}

let toastTimer;
function toast(text, ms = 2500) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// For debugging and the automated tests.
window.streamroom = { state, quality, reconnect };
