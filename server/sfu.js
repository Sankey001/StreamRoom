// StreamRoom SFU: socket.io signaling + mediasoup media forwarding.
// Every participant uploads each stream once; the server forwards it to the others.
// That is what makes 10 people at 1080p60 feasible (a P2P mesh would need 9 uploads each).

import crypto from 'node:crypto';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';

// Upper bound on what one participant may upload (camera + 1080p60/1440p60 screen + audio).
const MAX_INCOMING_BITRATE = 25_000_000;
const SOURCES = new Set(['mic', 'cam', 'screen', 'screen-audio']);
const MAX_TRANSPORTS_PER_PEER = 2; // one send, one recv
const CHAT_BURST = 5; // messages
const CHAT_WINDOW_MS = 5000;
const JOIN_FAILS_PER_MINUTE = 10; // per IP, against guessing meeting IDs
const MAX_MESSAGE_BYTES = 256 * 1024; // rtpCapabilities are the largest legit payload (~20 KB)

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '4d0032', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1500 } },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1500 } },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1500 } },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 0, 'x-google-start-bitrate': 1500 } },
];

/**
 * @param {object} opts
 * @param {import('node:http').Server[]} opts.servers  HTTP(S) servers to attach signaling to
 * @param {number} opts.rtcPort  single UDP+TCP port for all media
 * @param {{ip: string, announcedAddress?: string}[]} opts.listenIps
 * @param {number} [opts.maxPeers]
 * @param {(roomId: string) => boolean} [opts.allowRoom]
 * @param {(origin: string | undefined) => boolean} [opts.allowOrigin]  reject cross-site websocket connections
 * @param {number} [opts.graceMs]  how long a dropped peer may come back before others see them leave
 * @param {number} [opts.maxRooms]  meetings that may exist at once (a public server must cap this)
 * @param {string} [opts.roomPassword]  if set, every join must carry it
 */
export async function startSfu({
  servers, rtcPort, listenIps, maxPeers = 10,
  allowRoom = () => true, allowOrigin = () => true, graceMs = 20_000,
  maxRooms = Infinity, roomPassword = '',
}) {
  const worker = await mediasoup.createWorker({ logLevel: 'warn' });
  worker.on('died', () => {
    console.error('mediasoup worker died, exiting');
    process.exit(1);
  });
  // One port for all media (UDP, with TCP fallback) keeps firewall / port-forwarding simple.
  const webRtcServer = await worker.createWebRtcServer({
    listenInfos: listenIps.flatMap(({ ip, announcedAddress }) => [
      { protocol: 'udp', ip, announcedAddress, port: rtcPort },
      { protocol: 'tcp', ip, announcedAddress, port: rtcPort },
    ]),
  });

  const io = new Server({
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    // Notice a dead connection (Wi-Fi gone, laptop asleep) within ~10 s instead of socket.io's ~45 s.
    pingInterval: 5000,
    pingTimeout: 5000,
    allowRequest: (req, cb) => cb(null, allowOrigin(req.headers.origin)),
  });
  for (const s of servers) io.attach(s);

  /** @type {Map<string, Promise<Room>>} */
  const rooms = new Map();
  const joinFails = new Map(); // ip -> { count, resetAt }
  let closing = false;

  class Room {
    constructor(id, router, audioLevelObserver) {
      this.id = id;
      this.router = router;
      this.audioLevelObserver = audioLevelObserver;
      this.peers = new Map();
    }
  }

  function getRoom(id) {
    if (!rooms.has(id)) {
      if (rooms.size >= maxRooms) throw new Error('This server is already running as many meetings as it allows. Try again later.');
      rooms.set(id, (async () => {
        const router = await worker.createRouter({ mediaCodecs });
        const audioLevelObserver = await router.createAudioLevelObserver({ maxEntries: 1, threshold: -65, interval: 400 });
        audioLevelObserver.on('volumes', ([{ producer }]) => io.to(id).emit('activeSpeaker', { peerId: producer.appData.peerId }));
        audioLevelObserver.on('silence', () => io.to(id).emit('activeSpeaker', { peerId: null }));
        return new Room(id, router, audioLevelObserver);
      })());
    }
    return rooms.get(id);
  }

  const passwordHash = roomPassword ? crypto.createHash('sha256').update(roomPassword).digest() : null;
  function passwordOk(given) {
    if (!passwordHash) return true;
    const h = crypto.createHash('sha256').update(typeof given === 'string' ? given : '').digest();
    return crypto.timingSafeEqual(h, passwordHash);
  }

  function tooManyFails(ip) {
    const e = joinFails.get(ip);
    if (!e || e.resetAt < Date.now()) return false;
    return e.count >= JOIN_FAILS_PER_MINUTE;
  }
  function recordFail(ip) {
    const now = Date.now();
    const e = joinFails.get(ip);
    if (!e || e.resetAt < now) joinFails.set(ip, { count: 1, resetAt: now + 60_000 });
    else e.count += 1;
  }

  function broadcastSlowViewers(room) {
    const ids = [...room.peers.values()].filter((p) => p.slow).map((p) => p.id);
    io.to(room.id).emit('slowViewers', { ids });
  }

  /** Drop a peer's media (transports close their producers and consumers) but keep the peer. */
  function closeMedia(peer) {
    for (const t of peer.transports.values()) t.close();
    peer.transports.clear();
    peer.producers.clear();
    peer.consumers.clear();
    peer.recvTransport = null;
    peer.rtpCapabilities = null;
  }

  function removePeer(room, peer) {
    clearTimeout(peer.graceTimer);
    closeMedia(peer);
    if (room.peers.get(peer.id) !== peer) return;
    room.peers.delete(peer.id);
    io.to(room.id).emit('peerLeft', { id: peer.id });
    console.log(`[${room.id}] ${peer.name} left (${room.peers.size}/${maxPeers})`);
    if (peer.slow) broadcastSlowViewers(room);
    if (room.peers.size === 0) {
      room.router.close();
      rooms.delete(room.id);
    }
  }

  async function createConsumer(room, consumerPeer, producerPeer, producer) {
    const transport = consumerPeer.recvTransport;
    const socket = consumerPeer.socket;
    if (!transport || transport.closed || !socket || !consumerPeer.rtpCapabilities) return;
    if (!room.router.canConsume({ producerId: producer.id, rtpCapabilities: consumerPeer.rtpCapabilities })) return;

    let consumer;
    try {
      consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: consumerPeer.rtpCapabilities,
        paused: true,
        appData: { peerId: producerPeer.id, source: producer.appData.source },
      });
    } catch (err) {
      console.warn('consume failed:', err.message);
      return;
    }
    // When bandwidth is tight, mediasoup gives screen shares their bits before cameras.
    if (producer.appData.source === 'screen') await consumer.setPriority(255);

    consumerPeer.consumers.set(consumer.id, consumer);
    const notify = (event) => socket.emit(event, { consumerId: consumer.id });
    consumer.on('transportclose', () => consumerPeer.consumers.delete(consumer.id));
    consumer.on('producerclose', () => {
      consumerPeer.consumers.delete(consumer.id);
      notify('consumerClosed');
    });
    consumer.on('producerpause', () => notify('consumerPaused'));
    consumer.on('producerresume', () => notify('consumerResumed'));

    try {
      const res = await socket.timeout(10_000).emitWithAck('newConsumer', {
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        producerPaused: consumer.producerPaused,
        peerId: producerPeer.id,
        source: producer.appData.source,
      });
      if (res?.error) throw new Error(res.error);
      if (!consumer.closed) await consumer.resume();
    } catch (err) {
      console.warn('client could not consume:', err.message);
      consumer.close();
      consumerPeer.consumers.delete(consumer.id);
    }
  }

  io.on('connection', (socket) => {
    const ip = socket.handshake.address;
    let room = null;
    let peer = null;

    const on = (event, fn) => socket.on(event, async (data, ack) => {
      try {
        const result = await fn(data && typeof data === 'object' ? data : {});
        if (typeof ack === 'function') ack({ ok: true, ...result });
      } catch (err) {
        if (typeof ack === 'function') ack({ error: err.message });
      }
    });
    const requirePeer = () => {
      if (!peer || peer.socket !== socket) throw new Error('Not in a meeting');
    };
    const transportOf = (id) => {
      const t = peer.transports.get(id);
      if (!t) throw new Error('Unknown transport');
      return t;
    };
    const producerOf = (id) => {
      const p = peer.producers.get(id);
      if (!p) throw new Error('Unknown producer');
      return p;
    };

    on('join', async ({ roomId, name, token, password }) => {
      if (peer) throw new Error('Already joined');
      if (tooManyFails(ip)) throw new Error('Too many wrong meeting IDs. Wait a minute and try again.');
      if (!passwordOk(password)) {
        recordFail(ip);
        throw new Error('Wrong server password');
      }
      roomId = String(roomId || '').trim().toLowerCase();
      if (!/^[a-z0-9-]{1,48}$/.test(roomId) || !allowRoom(roomId)) {
        recordFail(ip);
        throw new Error('No meeting with that ID here');
      }
      name = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32) || 'Guest';

      let r = await getRoom(roomId);
      if (r.router.closed) r = await getRoom(roomId); // the room emptied out while we were waiting

      // Coming back after a dropped connection: same identity, fresh media.
      const old = typeof token === 'string' && token.length >= 32
        ? [...r.peers.values()].find((p) => p.token.length === token.length && crypto.timingSafeEqual(Buffer.from(p.token), Buffer.from(token)))
        : null;
      if (old) {
        clearTimeout(old.graceTimer);
        const previous = old.socket;
        old.socket = socket; // first, so the previous socket's disconnect handler ignores it
        if (previous && previous !== socket) previous.disconnect(true);
        closeMedia(old);
        old.slow = false;
        peer = old;
        room = r;
        socket.join(room.id);
        socket.to(room.id).emit('peerBack', { id: peer.id });
        console.log(`[${room.id}] ${peer.name} reconnected`);
      } else {
        if (r.peers.size >= maxPeers) throw new Error(`Meeting is full (max ${maxPeers} people)`);
        room = r;
        peer = {
          id: crypto.randomUUID(),
          token: crypto.randomBytes(24).toString('base64url'),
          name, socket, slow: false, graceTimer: null, chat: [],
          transports: new Map(), producers: new Map(), consumers: new Map(),
          recvTransport: null, rtpCapabilities: null,
        };
        room.peers.set(peer.id, peer);
        socket.join(room.id);
        socket.to(room.id).emit('peerJoined', { id: peer.id, name });
        console.log(`[${room.id}] ${name} joined (${room.peers.size}/${maxPeers})`);
      }
      const others = [...room.peers.values()].filter((p) => p !== peer).map((p) => ({ id: p.id, name: p.name, away: !p.socket }));
      return {
        peerId: peer.id,
        token: peer.token,
        name: peer.name,
        resumed: !!old,
        routerRtpCapabilities: room.router.rtpCapabilities,
        peers: others,
        slowViewers: others.filter((p) => room.peers.get(p.id).slow).map((p) => p.id),
        maxPeers,
      };
    });

    on('createTransport', async ({ direction }) => {
      requirePeer();
      if (direction !== 'send' && direction !== 'recv') throw new Error('Bad direction');
      if (peer.transports.size >= MAX_TRANSPORTS_PER_PEER) throw new Error('Too many transports');
      const transport = await room.router.createWebRtcTransport({
        webRtcServer,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 6_000_000,
        appData: { direction },
      });
      if (direction === 'send') await transport.setMaxIncomingBitrate(MAX_INCOMING_BITRATE).catch(() => {});
      else peer.recvTransport = transport;
      peer.transports.set(transport.id, transport);
      transport.on('dtlsstatechange', (s) => s === 'closed' && transport.close());
      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      };
    });

    on('connectTransport', async ({ transportId, dtlsParameters }) => {
      requirePeer();
      await transportOf(transportId).connect({ dtlsParameters });
    });

    // The network path changed (Wi-Fi roam, adapter switch): new ICE credentials, same transport.
    on('restartIce', async ({ transportId }) => {
      requirePeer();
      return { iceParameters: await transportOf(transportId).restartIce() };
    });

    // Client has both transports and its capabilities: start receiving everything already in the room.
    on('ready', async ({ rtpCapabilities }) => {
      requirePeer();
      if (!rtpCapabilities || !Array.isArray(rtpCapabilities.codecs)) throw new Error('Bad capabilities');
      peer.rtpCapabilities = rtpCapabilities;
      for (const other of room.peers.values()) {
        if (other === peer) continue;
        for (const producer of other.producers.values()) createConsumer(room, peer, other, producer);
      }
    });

    on('produce', async ({ transportId, kind, rtpParameters, appData }) => {
      requirePeer();
      const source = appData?.source;
      if (!SOURCES.has(source)) throw new Error('Bad source');
      const expectedKind = source === 'mic' || source === 'screen-audio' ? 'audio' : 'video';
      if (kind !== expectedKind) throw new Error('Bad kind');
      if ([...peer.producers.values()].some((p) => p.appData.source === source)) throw new Error(`Already producing ${source}`);

      const transport = transportOf(transportId);
      if (transport.appData.direction !== 'send') throw new Error('Not a send transport');
      const producer = await transport.produce({ kind, rtpParameters, appData: { source, peerId: peer.id } });
      const owner = peer;
      owner.producers.set(producer.id, producer);
      producer.on('transportclose', () => owner.producers.delete(producer.id));
      if (source === 'mic') room.audioLevelObserver.addProducer({ producerId: producer.id }).catch(() => {});

      for (const other of room.peers.values()) {
        if (other !== owner) createConsumer(room, other, owner, producer);
      }
      return { id: producer.id };
    });

    on('closeProducer', async ({ producerId }) => {
      requirePeer();
      producerOf(producerId).close();
      peer.producers.delete(producerId);
    });

    on('pauseProducer', async ({ producerId }) => {
      requirePeer();
      await producerOf(producerId).pause();
    });

    on('resumeProducer', async ({ producerId }) => {
      requirePeer();
      await producerOf(producerId).resume();
    });

    // Clients ask for a lower simulcast layer for small tiles to save everyone's bandwidth.
    on('setConsumerLayers', async ({ consumerId, spatialLayer }) => {
      requirePeer();
      const consumer = peer.consumers.get(consumerId);
      if (!consumer || consumer.type !== 'simulcast') return;
      await consumer.setPreferredLayers({ spatialLayer: Math.max(0, Math.min(2, Number(spatialLayer) || 0)) });
    });

    // A viewer with slow download asks screen sharers to cap at 720p.
    on('netStatus', async ({ slow }) => {
      requirePeer();
      if (peer.slow === !!slow) return;
      peer.slow = !!slow;
      broadcastSlowViewers(room);
    });

    on('chat', async ({ text }) => {
      requirePeer();
      const now = Date.now();
      peer.chat = peer.chat.filter((t) => now - t < CHAT_WINDOW_MS);
      if (peer.chat.length >= CHAT_BURST) throw new Error('Slow down a little');
      text = String(text || '').trim().slice(0, 1000);
      if (!text) return;
      peer.chat.push(now);
      io.to(room.id).emit('chat', { peerId: peer.id, name: peer.name, text, ts: now });
    });

    on('leave', async () => {
      if (!peer || peer.socket !== socket) return;
      const p = peer;
      peer = null;
      p.socket = null;
      removePeer(room, p);
    });

    socket.on('disconnect', () => {
      if (!peer || peer.socket !== socket) return; // already left, or replaced by a reconnect
      const p = peer;
      peer = null;
      p.socket = null;
      closeMedia(p);
      if (p.slow) {
        p.slow = false;
        broadcastSlowViewers(room);
      }
      if (closing) return removePeer(room, p);
      io.to(room.id).emit('peerAway', { id: p.id });
      p.graceTimer = setTimeout(() => removePeer(room, p), graceMs);
    });
  });

  return {
    io,
    roomCount: () => rooms.size,
    /** Ends every meeting: clients are told it was on purpose so they don't try to reconnect. */
    async close() {
      closing = true;
      io.emit('meetingEnded');
      await new Promise((r) => setTimeout(r, 300));
      io.disconnectSockets(true);
      io.close();
      worker.close();
    },
  };
}
