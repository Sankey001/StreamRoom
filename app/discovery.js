// Finding a host on the local network from just a meeting ID.
// Two strategies race: a UDP broadcast "any StreamRoom hosts here?", and a direct HTTP probe of the
// address the ID points at (same subnet, last octet taken from the ID).
//
// The meeting ID itself is never broadcast. It is only sent, one-to-one, to an address whose last
// octet matches the one encoded in the ID, so neither a listener nor a fake "host" answering
// broadcasts can collect IDs.

import dgram from 'node:dgram';
import http from 'node:http';
import { localIPv4s } from '../server/net.js';
import { codeOctet, normalizeCode } from '../client/code.js';

export const SIGNAL_PORT = 47800;
export const RTC_PORT = 47801;
export const DISCOVERY_PORT = 47802;
const MAGIC = 'STREAMROOM2';
export const QUERY = `${MAGIC} ?`;

/**
 * Per-IP limiter so nobody on the network can guess meeting IDs by brute force
 * (4 million possible IDs; at 60 guesses a minute that's years).
 */
export function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const e = hits.get(key);
    if (!e || e.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 10_000) hits.clear();
      return true;
    }
    e.count += 1;
    return e.count <= max;
  };
}

/**
 * Host side: the HTTP endpoint a joiner uses to check an ID.
 * /info?code=X only confirms a correct ID; it never reveals the ID to someone who doesn't have it.
 */
export function createInfoHandler(code) {
  const allowLookup = makeLimiter(30, 60_000);
  return (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return res.writeHead(400).end(); // a garbled request must never take the host down
    }
    if (url.pathname !== '/info') return res.writeHead(404).end();
    if (!allowLookup(req.socket.remoteAddress)) return res.writeHead(429).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'streamroom', match: normalizeCode(url.searchParams.get('code')) === code }));
  };
}

/** Host side: answer "any hosts here?" broadcasts with just our signaling port. */
export function startResponder({ port }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const allow = makeLimiter(60, 60_000);
  socket.on('message', (msg, rinfo) => {
    if (msg.length > 64 || !allow(rinfo.address)) return;
    if (msg.toString() !== QUERY) return;
    socket.send(JSON.stringify({ magic: MAGIC, port }), rinfo.port, rinfo.address);
  });
  socket.on('error', (err) => console.warn('discovery responder:', err.message));
  socket.bind(DISCOVERY_PORT);
  return () => socket.close();
}

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const { address, netmask } of localIPv4s()) {
    const a = address.split('.').map(Number);
    const m = netmask.split('.').map(Number);
    out.add(a.map((x, i) => (x & m[i]) | (~m[i] & 255)).join('.'));
  }
  return [...out];
}

function viaBroadcast(code, signal) {
  const octet = codeOctet(code);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const asked = new Set();
    let timer;
    const done = () => {
      clearInterval(timer);
      try { socket.close(); } catch { /* already closed */ }
    };
    signal.addEventListener('abort', () => {
      done();
      reject(new Error('aborted'));
    });
    socket.on('message', (msg, rinfo) => {
      let info;
      try {
        info = JSON.parse(msg.toString());
      } catch {
        return;
      }
      if (info?.magic !== MAGIC || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) return;
      // Only the host the ID points at gets asked. Anyone else answering broadcasts never sees the ID.
      if (Number(rinfo.address.split('.')[3]) !== octet) return;
      const key = `${rinfo.address}:${info.port}`;
      if (asked.has(key)) return;
      asked.add(key);
      probe(rinfo.address, info.port, signal, code).then((found) => {
        done();
        resolve(found);
      }, () => {});
    });
    socket.on('error', () => { /* keep trying with the HTTP probe */ });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const send = () => {
        for (const addr of broadcastAddresses()) socket.send(QUERY, DISCOVERY_PORT, addr, () => {});
      };
      send();
      timer = setInterval(send, 700);
    });
  });
}

/** Ask one host whether it has our meeting. A fresh connection each time: a pooled one may point at a host that's gone. */
function probe(address, port, signal, code) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: address, port, path: `/info?code=${code}`, agent: false, timeout: 2500,
      signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 1024) req.destroy(); });
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          if (info.app === 'streamroom' && info.match === true) return resolve({ address, port, code });
        } catch { /* not a StreamRoom host */ }
        reject(new Error('not this meeting'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function viaDirectProbe(code, signal) {
  const octet = codeOctet(code);
  const targets = new Set(['127.0.0.1']); // a meeting hosted on this same PC
  for (const { address } of localIPv4s()) targets.add(address.split('.').slice(0, 3).concat(octet).join('.'));
  return Promise.any([...targets].map((ip) => probe(ip, SIGNAL_PORT, signal, code)));
}

/**
 * @param {string} code normalized meeting ID
 * @returns {Promise<{address: string, port: number, code: string}>}
 */
export async function findHost(code, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs));
  try {
    return await Promise.race([
      Promise.any([viaBroadcast(code, controller.signal), viaDirectProbe(code, controller.signal)]),
      timeout,
    ]);
  } catch {
    throw new Error('No meeting with this ID was found. Check the ID, and that you are on the same Wi-Fi/network as the host.');
  } finally {
    controller.abort();
  }
}

/** Host address typed by hand ("100.101.102.103" or with ":port"), e.g. over Tailscale / Radmin VPN. */
export async function findHostByAddress(input, code) {
  const [address, port] = input.trim().split(':');
  try {
    return await probe(address, Number(port) || SIGNAL_PORT, new AbortController().signal, code);
  } catch {
    throw new Error(`No meeting with this ID is running at ${input}.`);
  }
}
