// StreamRoom desktop app. Whoever clicks "Start meeting" runs the SFU inside their app;
// everyone else finds that host on the local network by meeting ID.

import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, session, desktopCapturer } from 'electron';
import { startSfu } from '../server/sfu.js';
import { localIPv4s, primaryIp } from '../server/net.js';
import { makeCode, normalizeCode } from '../client/code.js';
import { SIGNAL_PORT, RTC_PORT, startResponder, findHost, findHostByAddress, createInfoHandler } from './discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);

let win = null;
let hosting = null; // { code, close }

async function startHosting() {
  if (hosting) return { code: hosting.code, port: SIGNAL_PORT };
  const ip = primaryIp();
  const code = makeCode(Number(ip.split('.')[3]) || 0);
  const roomId = code.toLowerCase();

  const server = http.createServer(createInfoHandler(code));
  await new Promise((resolve, reject) => {
    server.once('error', (err) => reject(err.code === 'EADDRINUSE'
      ? new Error('A meeting is already running on this PC (maybe in another StreamRoom window).')
      : err));
    server.listen(SIGNAL_PORT, '0.0.0.0', resolve);
  });

  // Listen for media on every adapter (Wi-Fi, Ethernet, VPNs like Tailscale/Radmin) so any route works.
  const ips = localIPv4s().map((i) => i.address);
  let sfu;
  try {
    sfu = await startSfu({
      servers: [server],
      rtcPort: RTC_PORT,
      listenIps: (ips.length ? ips : ['127.0.0.1']).map((a) => ({ ip: a })),
      allowRoom: (id) => id === roomId,
      // Only the StreamRoom app (file:// page) may connect, not a web page someone opens in a browser.
      allowOrigin: (origin) => origin === undefined || origin === 'file://' || origin === 'null',
    });
  } catch (err) {
    server.close();
    throw err;
  }
  const stopResponder = startResponder({ port: SIGNAL_PORT });

  hosting = {
    code,
    async close() {
      stopResponder();
      await sfu.close();
      server.close();
      console.log(`Meeting ${code} ended`);
    },
  };
  console.log(`Hosting meeting ${code} on ${ips.join(', ')}`);
  return { code, port: SIGNAL_PORT, ips };
}

async function stopHosting() {
  const h = hosting;
  hosting = null;
  await h?.close();
}

ipcMain.handle('host:start', () => startHosting());
ipcMain.handle('host:stop', () => stopHosting());
ipcMain.handle('host:find', async (_e, { code: input, address } = {}) => {
  const code = normalizeCode(input);
  if (!code) throw new Error('A meeting ID is 6 letters/numbers, like K7P-2QX.');
  address = String(address || '').trim();
  if (address) {
    if (!/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/.test(address)) throw new Error('The host address should look like 100.101.102.103');
    return findHostByAddress(address, code);
  }
  return findHost(code);
});

// Screen picker: Electron has no built-in one on Windows, so the renderer shows ours.
let pickSeq = 0;
function askRendererForSource(sources) {
  const id = ++pickSeq;
  return new Promise((resolve) => {
    const onResult = (_e, res) => {
      if (res?.id !== id) return;
      ipcMain.removeListener('screen:picked', onResult);
      resolve(res.choice);
    };
    ipcMain.on('screen:picked', onResult);
    win.webContents.send('screen:pick', {
      id,
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        screen: s.id.startsWith('screen:'),
        thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      })),
    });
  });
}

function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
      const choice = await askRendererForSource(sources);
      const source = choice && sources.find((s) => s.id === choice.id);
      if (!source) return callback({});
      // 'loopback' = system audio, only available on Windows.
      callback({ video: source, ...(choice.audio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
    } catch (err) {
      console.error('screen picker failed:', err);
      callback({});
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0d0e12',
    title: 'StreamRoom',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      // Keep encoding at full speed while the window is minimized during a screen share.
      backgroundThrottling: false,
    },
  });
  const page = path.join(__dirname, '..', 'public', 'index.html');
  win.loadFile(page);
  // Never leave the app's own page (a malicious link or redirect can't take over the window).
  const own = pathToFileURL(page).href;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url.split(/[?#]/)[0] !== own) e.preventDefault();
  });
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  setupSession();
  createWindow();
});

app.on('window-all-closed', async () => {
  await stopHosting().catch(() => {});
  app.quit();
});
