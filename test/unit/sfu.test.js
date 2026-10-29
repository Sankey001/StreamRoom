// Signaling server behaviour, including the abuse cases (security tests) and reconnect rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as connect } from 'socket.io-client';
import { startSfu } from '../../server/sfu.js';

let nextRtcPort = 51000 + Math.floor(Math.random() * 1000);

async function startServer(opts = {}) {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sfu = await startSfu({ servers: [server], rtcPort: nextRtcPort++, listenIps: [{ ip: '127.0.0.1' }], ...opts });
  const url = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  const client = (extra = {}) => new Promise((resolve, reject) => {
    const s = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false, ...extra });
    sockets.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
  return {
    sfu, url, client,
    async close() {
      for (const s of sockets) s.close();
      await sfu.close();
      server.close();
    },
  };
}

const req = (s, event, data = {}) => s.timeout(5000).emitWithAck(event, data);
const next = (s, event, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no ${event} within ${ms} ms`)), ms);
  s.once(event, (d) => { clearTimeout(t); resolve(d); });
});
const none = (s, event, ms) => new Promise((resolve, reject) => {
  const h = () => reject(new Error(`unexpected ${event}`));
  s.once(event, h);
  setTimeout(() => { s.off(event, h); resolve(); }, ms);
});

test('join: validates the meeting ID and caps the room at 10', async () => {
  const srv = await startServer({ allowRoom: (id) => id === 'abc123' });
  try {
    const a = await srv.client();
    assert.match((await req(a, 'join', { roomId: 'nope00' })).error, /No meeting/);
    assert.match((await req(a, 'join', { roomId: '../../etc' })).error, /No meeting/);
    const ok = await req(a, 'join', { roomId: 'ABC123', name: 'A' });
    assert.ok(ok.ok && ok.peerId && ok.token.length >= 32);
    assert.match((await req(a, 'join', { roomId: 'abc123' })).error, /Already joined/);
    for (let i = 0; i < 9; i++) assert.ok((await req(await srv.client(), 'join', { roomId: 'abc123' })).ok);
    assert.match((await req(await srv.client(), 'join', { roomId: 'abc123' })).error, /full/);
  } finally {
    await srv.close();
  }
});

test('security: guessing meeting IDs is rate-limited per IP', async () => {
  const srv = await startServer({ allowRoom: (id) => id === 'secret' });
  try {
    for (let i = 0; i < 10; i++) {
      const s = await srv.client();
      assert.match((await req(s, 'join', { roomId: `guess${i}` })).error, /No meeting/);
    }
    // Even the right ID is refused for a while once the limit is hit.
    assert.match((await req(await srv.client(), 'join', { roomId: 'secret' })).error, /Too many/);
  } finally {
    await srv.close();
  }
});

test('security: a public server caps how many meetings strangers can start', async () => {
  const srv = await startServer({ maxRooms: 2 });
  try {
    const a = await srv.client();
    assert.ok((await req(a, 'join', { roomId: 'one' })).ok);
    assert.ok((await req(await srv.client(), 'join', { roomId: 'two' })).ok);
    assert.match((await req(await srv.client(), 'join', { roomId: 'three' })).error, /as many meetings/);
    assert.ok((await req(await srv.client(), 'join', { roomId: 'two' })).ok); // existing meetings still open
    await req(a, 'leave'); // meeting "one" empties and closes
    await new Promise((r) => setTimeout(r, 100));
    assert.ok((await req(await srv.client(), 'join', { roomId: 'three' })).ok);
  } finally {
    await srv.close();
  }
});

test('security: a server password is required for every join, and wrong guesses are rate-limited', async () => {
  const srv = await startServer({ roomPassword: 'hunter2-but-longer' });
  try {
    assert.match((await req(await srv.client(), 'join', { roomId: 'r1' })).error, /Wrong server password/);
    assert.match((await req(await srv.client(), 'join', { roomId: 'r1', password: 'hunter2' })).error, /Wrong server password/);
    assert.match((await req(await srv.client(), 'join', { roomId: 'r1', password: { toString: 1 } })).error, /Wrong server password/);
    assert.ok((await req(await srv.client(), 'join', { roomId: 'r1', password: 'hunter2-but-longer' })).ok);
    for (let i = 0; i < 8; i++) await req(await srv.client(), 'join', { roomId: 'r1', password: `guess${i}` });
    assert.match((await req(await srv.client(), 'join', { roomId: 'r1', password: 'hunter2-but-longer' })).error, /Too many/);
  } finally {
    await srv.close();
  }
});

test('security: cross-site websocket connections are refused', async () => {
  const srv = await startServer({ allowOrigin: (o) => o === undefined || o === 'file://' });
  try {
    await assert.rejects(srv.client({ extraHeaders: { origin: 'https://evil.example' } }));
    assert.ok((await srv.client({ extraHeaders: { origin: 'file://' } })).connected);
  } finally {
    await srv.close();
  }
});

test('security: nothing works before joining', async () => {
  const srv = await startServer();
  try {
    const s = await srv.client();
    for (const ev of ['createTransport', 'produce', 'chat', 'netStatus', 'restartIce', 'setConsumerLayers']) {
      assert.match((await req(s, ev, { direction: 'send' })).error, /Not in a meeting/, ev);
    }
  } finally {
    await srv.close();
  }
});

test('security: names are sanitized and chat is passed through as plain text', async () => {
  const srv = await startServer();
  try {
    const a = await srv.client();
    const res = await req(a, 'join', { roomId: 'r1', name: `\u0000\u001bEvil${'x'.repeat(100)}` });
    assert.equal(res.name, `Evil${'x'.repeat(28)}`);
    const msg = next(a, 'chat');
    await req(a, 'chat', { text: '<img src=x onerror=alert(1)>' });
    assert.equal((await msg).text, '<img src=x onerror=alert(1)>'); // the client renders it with textContent
    assert.equal((await req(a, 'join', 'not-an-object')).error, 'Already joined'); // junk payloads don't crash
  } finally {
    await srv.close();
  }
});

test('security: resource limits (transports, chat flood, bad producers, oversized messages)', async () => {
  const srv = await startServer();
  try {
    const a = await srv.client();
    await req(a, 'join', { roomId: 'r1' });
    const send = await req(a, 'createTransport', { direction: 'send' });
    assert.ok(send.ok);
    assert.ok((await req(a, 'createTransport', { direction: 'recv' })).ok);
    assert.match((await req(a, 'createTransport', { direction: 'recv' })).error, /Too many/);
    assert.match((await req(a, 'createTransport', { direction: 'sideways' })).error, /Too many|Bad/);

    assert.match((await req(a, 'produce', { transportId: send.id, kind: 'video', appData: { source: 'evil' } })).error, /Bad source/);
    assert.match((await req(a, 'produce', { transportId: send.id, kind: 'video', appData: { source: 'mic' } })).error, /Bad kind/);
    assert.match((await req(a, 'produce', { transportId: 'x', kind: 'audio', appData: { source: 'mic' } })).error, /Unknown transport/);
    assert.ok((await req(a, 'produce', { transportId: send.id, kind: 'audio', rtpParameters: { garbage: true }, appData: { source: 'mic' } })).error);

    for (let i = 0; i < 5; i++) assert.ok((await req(a, 'chat', { text: `hi ${i}` })).ok);
    assert.match((await req(a, 'chat', { text: 'spam' })).error, /Slow down/);

    const dropped = next(a, 'disconnect');
    a.emit('chat', { text: 'x'.repeat(300 * 1024) });
    await dropped; // over the 256 KB message cap: the server drops the connection
  } finally {
    await srv.close();
  }
});

test('reconnect: a dropped peer is "away", then resumes with the same identity', async () => {
  const srv = await startServer({ graceMs: 3000 });
  try {
    const host = await srv.client();
    await req(host, 'join', { roomId: 'r1', name: 'Host' });
    let a = await srv.client();
    const first = await req(a, 'join', { roomId: 'r1', name: 'Asha' });

    const away = next(host, 'peerAway');
    a.close(); // Wi-Fi blip
    assert.equal((await away).id, first.peerId);

    const back = next(host, 'peerBack');
    const noLeave = none(host, 'peerLeft', 500);
    a = await srv.client();
    const again = await req(a, 'join', { roomId: 'r1', name: 'Asha', token: first.token });
    assert.equal(again.peerId, first.peerId);
    assert.equal(again.resumed, true);
    assert.equal((await back).id, first.peerId);
    await noLeave;
  } finally {
    await srv.close();
  }
});

test('reconnect: a wrong token is just a new person, and the grace period expires', async () => {
  const srv = await startServer({ graceMs: 400 });
  try {
    const host = await srv.client();
    await req(host, 'join', { roomId: 'r1' });
    const a = await srv.client();
    const first = await req(a, 'join', { roomId: 'r1' });
    const left = next(host, 'peerLeft', 2000);
    a.close();
    assert.equal((await left).id, first.peerId);

    const b = await srv.client();
    const forged = await req(b, 'join', { roomId: 'r1', token: `${first.token.slice(0, -1)}x` });
    assert.notEqual(forged.peerId, first.peerId);
    assert.equal(forged.resumed, false);
  } finally {
    await srv.close();
  }
});

test('reconnect: the same token from a second connection replaces the stale one', async () => {
  const srv = await startServer();
  try {
    const a1 = await srv.client();
    const first = await req(a1, 'join', { roomId: 'r1' });
    const a2 = await srv.client();
    const kicked = next(a1, 'disconnect');
    const again = await req(a2, 'join', { roomId: 'r1', token: first.token });
    assert.equal(again.peerId, first.peerId);
    await kicked;
    assert.ok((await req(a2, 'chat', { text: 'still here' })).ok);
  } finally {
    await srv.close();
  }
});

test('leaving on purpose removes the peer immediately', async () => {
  const srv = await startServer({ graceMs: 60_000 });
  try {
    const host = await srv.client();
    await req(host, 'join', { roomId: 'r1' });
    const a = await srv.client();
    const me = await req(a, 'join', { roomId: 'r1' });
    const left = next(host, 'peerLeft', 1000);
    await req(a, 'leave');
    assert.equal((await left).id, me.peerId);
  } finally {
    await srv.close();
  }
});

test('slow-download reports reach screen sharers', async () => {
  const srv = await startServer();
  try {
    const sharer = await srv.client();
    await req(sharer, 'join', { roomId: 'r1' });
    const viewer = await srv.client();
    const v = await req(viewer, 'join', { roomId: 'r1' });
    const on = next(sharer, 'slowViewers');
    await req(viewer, 'netStatus', { slow: true });
    assert.deepEqual((await on).ids, [v.peerId]);
    const off = next(sharer, 'slowViewers');
    viewer.close(); // a slow viewer who drops no longer holds everyone at 720p
    assert.deepEqual((await off).ids, []);
  } finally {
    await srv.close();
  }
});

test('ICE restart returns fresh credentials', async () => {
  const srv = await startServer();
  try {
    const a = await srv.client();
    await req(a, 'join', { roomId: 'r1' });
    const t = await req(a, 'createTransport', { direction: 'recv' });
    const r = await req(a, 'restartIce', { transportId: t.id });
    assert.ok(r.iceParameters.usernameFragment);
    assert.notEqual(r.iceParameters.password, t.iceParameters.password);
  } finally {
    await srv.close();
  }
});

test('host closing the meeting tells everyone it ended on purpose', async () => {
  const srv = await startServer();
  const a = await srv.client();
  await req(a, 'join', { roomId: 'r1' });
  const ended = next(a, 'meetingEnded');
  await srv.sfu.close();
  await ended;
  await srv.close();
});
