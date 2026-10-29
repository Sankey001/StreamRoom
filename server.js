// StreamRoom browser mode: serves the web client over HTTPS so people can join from any browser.
// The desktop app (app/main.js) runs the same SFU when someone hosts a meeting.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { generate as generateCert } from 'selfsigned';
import { startSfu } from './server/sfu.js';
import { primaryIp } from './server/net.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.HTTPS_PORT || 3000);
// Plain HTTP for the host's own browser only: localhost counts as a secure origin, so no cert warning.
const LOCAL_HTTP_PORT = Number(process.env.LOCAL_HTTP_PORT || 3080);
const RTC_PORT = Number(process.env.RTC_PORT || 44444);
const LISTEN_IP = process.env.LISTEN_IP || '0.0.0.0';
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || primaryIp();
const MAX_PEERS = Number(process.env.MAX_PEERS || 10);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 5);
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || '';

async function loadTls() {
  if (process.env.TLS_CERT && process.env.TLS_KEY) {
    return { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) };
  }
  // Browsers only allow camera/mic/screen capture on secure origins, so LAN guests need HTTPS.
  const dir = path.join(__dirname, 'certs');
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  const ipFile = path.join(dir, 'ip.txt');
  const fresh = fs.existsSync(certFile) && fs.existsSync(ipFile) && fs.readFileSync(ipFile, 'utf8') === ANNOUNCED_IP;
  if (!fresh) {
    fs.mkdirSync(dir, { recursive: true });
    const pems = await generateCert([{ name: 'commonName', value: 'StreamRoom' }], {
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 825 * 24 * 3600 * 1000),
      extensions: [{
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 7, ip: ANNOUNCED_IP }],
      }],
    });
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(keyFile, pems.private);
    fs.writeFileSync(ipFile, ANNOUNCED_IP);
  }
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = https.createServer(await loadTls(), app);
const localServer = http.createServer(app);
const sfu = await startSfu({
  servers: [server, localServer],
  rtcPort: RTC_PORT,
  listenIps: [{ ip: LISTEN_IP, announcedAddress: ANNOUNCED_IP }],
  maxPeers: MAX_PEERS,
  // Anyone who finds a public server can start meetings, so cap them, and optionally lock it.
  maxRooms: MAX_ROOMS,
  roomPassword: ROOM_PASSWORD,
});
app.get('/health', (_req, res) => res.json({ ok: true, rooms: sfu.roomCount() }));

localServer.listen(LOCAL_HTTP_PORT, '127.0.0.1');
server.listen(PORT, () => {
  console.log(`StreamRoom running
  This machine : http://localhost:${LOCAL_HTTP_PORT}  (or https://localhost:${PORT})
  Your network : https://${ANNOUNCED_IP}:${PORT}
  Media port   : ${RTC_PORT} (UDP + TCP), announced as ${ANNOUNCED_IP}
  Limits       : ${MAX_ROOMS} meetings, ${MAX_PEERS} people each, ${ROOM_PASSWORD ? 'password required' : 'no password (set ROOM_PASSWORD before putting this online)'}`);
});
