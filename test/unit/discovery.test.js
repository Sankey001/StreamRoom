// LAN discovery: finding a host from a meeting ID, and not leaking or brute-forcing IDs.
// Uses the real discovery ports, so don't run it while a StreamRoom meeting is hosted on this PC.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { makeCode, normalizeCode } from '../../client/code.js';
import { primaryIp } from '../../server/net.js';
import {
  SIGNAL_PORT, DISCOVERY_PORT, QUERY, startResponder, findHost, findHostByAddress, makeLimiter, createInfoHandler,
} from '../../app/discovery.js';

const listen = (server, port = 0, host = '127.0.0.1') => new Promise((r) => server.listen(port, host, () => {
  // Close for real, keep-alive connections included, so the next test can't reach this server.
  const close = server.close.bind(server);
  server.close = () => { server.closeAllConnections(); return close(); };
  r(server);
}));

function fakeHost(code) {
  return listen(http.createServer(createInfoHandler(code)), SIGNAL_PORT, '0.0.0.0');
}

function udpQuery(message, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('message', (m) => { s.close(); resolve(JSON.parse(m)); });
    s.bind(0, () => s.send(message, DISCOVERY_PORT, '127.0.0.1'));
    setTimeout(() => { try { s.close(); } catch { /* closed */ } resolve(null); }, timeoutMs);
  });
}

function rawRequest(port, text) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    s.on('data', (d) => { s.destroy(); resolve(String(d).split('\r\n')[0]); });
    s.on('error', () => resolve('connection error'));
    setTimeout(() => { s.destroy(); resolve('no answer'); }, 2000);
  });
}

test('limiter allows a burst, then blocks that address only', () => {
  const allow = makeLimiter(3, 60_000);
  assert.deepEqual([1, 2, 3, 4].map(() => allow('10.0.0.5')), [true, true, true, false]);
  assert.equal(allow('10.0.0.6'), true);
});

test('security: a garbled request gets "400", and the host keeps working', async () => {
  const code = makeCode(1);
  const server = await listen(http.createServer(createInfoHandler(code)));
  try {
    const port = server.address().port;
    for (const bad of ['GET //[ HTTP/1.1', 'GET //:99999 HTTP/1.1', 'GET http://[::1 HTTP/1.1']) {
      assert.match(await rawRequest(port, `${bad}\r\nHost: x\r\n\r\n`), /400/, bad);
    }
    const ok = await fetch(`http://127.0.0.1:${port}/info?code=${code}`).then((r) => r.json());
    assert.equal(ok.match, true);
  } finally {
    server.close();
  }
});

test('security: /info confirms a correct ID but never reveals it', async () => {
  const code = makeCode(1);
  const server = await listen(http.createServer(createInfoHandler(code)));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const wrong = await fetch(`${base}/info?code=${makeCode(1)}`).then((r) => r.text());
    assert.equal(JSON.parse(wrong).match, false);
    assert.ok(!wrong.includes(code));
    assert.equal((await fetch(`${base}/anything-else`)).status, 404);
  } finally {
    server.close();
  }
});

test('responder answers the generic query with only its port', async () => {
  const stop = startResponder({ port: SIGNAL_PORT });
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await udpQuery(QUERY), { magic: 'STREAMROOM2', port: SIGNAL_PORT });
    assert.equal(await udpQuery('STREAMROOM1 K7P2QX'), null); // old ID-carrying query
    assert.equal(await udpQuery('garbage'), null);
  } finally {
    stop();
  }
});

test('security: someone listening to broadcasts never sees the meeting ID', async () => {
  const code = makeCode(200);
  const heard = [];
  const eavesdropper = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  eavesdropper.on('message', (m) => heard.push(String(m)));
  await new Promise((r) => eavesdropper.bind(DISCOVERY_PORT, r));
  try {
    await assert.rejects(findHost(code, 1500));
    assert.ok(heard.length > 0, 'the eavesdropper should have received the broadcast');
    for (const m of heard) {
      assert.equal(m, QUERY);
      assert.ok(!m.includes(code));
    }
  } finally {
    eavesdropper.close();
  }
});

test('security: a fake "host" answering broadcasts is never sent the ID', async () => {
  // The fake answers from this PC's LAN address; the ID points at a different last octet.
  const myOctet = Number(primaryIp().split('.')[3]);
  const code = makeCode((myOctet + 77) % 256);
  const asked = [];
  const trap = await listen(http.createServer((req, res) => {
    if (req.socket.localAddress !== '127.0.0.1') asked.push(req.url); // ignore the same-PC probe
    res.end('{}');
  }), SIGNAL_PORT, '0.0.0.0');
  const fake = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  fake.on('message', (_m, r) => fake.send(JSON.stringify({ magic: 'STREAMROOM2', port: SIGNAL_PORT }), r.port, r.address));
  await new Promise((r) => fake.bind(DISCOVERY_PORT, r));
  try {
    await assert.rejects(findHost(code, 2000));
    assert.deepEqual(asked, []);
  } finally {
    fake.close();
    trap.close();
  }
});

test('findHost locates a meeting on this PC from the ID alone', async () => {
  const code = makeCode(1);
  const server = await fakeHost(code);
  try {
    const found = await findHost(code, 4000);
    assert.equal(found.port, SIGNAL_PORT);
    assert.equal(found.code, code);
  } finally {
    server.close();
  }
});

test('findHost gives a friendly error for an unknown ID', async () => {
  const server = await fakeHost(makeCode(1));
  try {
    await assert.rejects(findHost(makeCode(1), 1500), /No meeting with this ID was found/);
  } finally {
    server.close();
  }
});

test('joining by address (VPN) still requires the right ID', async () => {
  const code = makeCode(1);
  const server = await fakeHost(code);
  try {
    assert.equal((await findHostByAddress('127.0.0.1', code)).address, '127.0.0.1');
    await assert.rejects(findHostByAddress('127.0.0.1', normalizeCode(makeCode(1))), /No meeting/);
  } finally {
    server.close();
  }
});
