// Auto quality. Three things push quality down, and each recovers on its own:
//  1. Group size: smaller cameras as more people join (everyone decodes everyone; the host forwards it all).
//  2. Slow PC: the encoder is CPU-limited, or incoming video is dropping frames.
//  3. Slow internet: upload or download can't keep up, so cap everything at 720p.
// Stepping down needs 2 bad samples in a row; stepping back up needs 10 good ones (~30 s).

export const CAM_TIERS = [
  { label: '1080p60', height: 1080, fps: 60, bitrate: 4_500_000 },
  { label: '720p30', height: 720, fps: 30, bitrate: 1_800_000 },
  { label: '540p30', height: 540, fps: 30, bitrate: 1_000_000 },
  { label: '360p24', height: 360, fps: 24, bitrate: 500_000 },
];
const CAM_720P = 1;
// Screen shares keep their resolution as long as possible; frame rate goes first.
export const SCREEN_TIERS = [
  { fps: 60, scale: 1 },
  { fps: 30, scale: 1 },
  { fps: 30, scale: 1.5 },
];
export const SLOW_NET_HEIGHT = 720;
export const SLOW_NET_SCREEN_BITRATE = 3_500_000;
const SIMULCAST_SHARES = [0.07, 0.25, 1]; // bitrate of each camera layer, low to high
const MAX_PENALTY = 2;
const STRIKES_TO_STEP_DOWN = 2;
const HEALTHY_TO_STEP_UP = 10;

// What counts as "slow internet".
const MAX_LOSS = 0.04; // 4 % packet loss
const MAX_RTT = 0.3; // 300 ms round trip
const MIN_UPLINK = 2_500_000; // available upload while sending video
const WARMUP_MS = 15_000;

export function camTierForGroup(people) {
  if (people <= 2) return 0;
  if (people <= 4) return 1;
  if (people <= 6) return 2;
  return 3;
}

/** The host forwards the screen to everyone else, so split a ~32 Mbps budget between viewers. */
export function screenBitrateForGroup(people, presetBitrate) {
  const viewers = Math.max(1, people - 1);
  return Math.min(presetBitrate, Math.max(3_000_000, Math.round(32_000_000 / viewers)));
}

/** Penalty counter with hysteresis (0..MAX_PENALTY). */
export function nextPenalty(prev, bad, healthy) {
  let { penalty, strikes, good } = prev;
  if (bad) {
    strikes += 1;
    good = 0;
    if (strikes >= STRIKES_TO_STEP_DOWN) {
      penalty = Math.min(MAX_PENALTY, penalty + 1);
      strikes = 0;
    }
  } else {
    strikes = 0;
    good = healthy ? good + 1 : 0;
    if (good >= HEALTHY_TO_STEP_UP && penalty > 0) {
      penalty -= 1;
      good = 0;
    }
  }
  return { penalty, strikes, good };
}

/** On/off flag with the same hysteresis, used for "slow internet". */
export function nextFlag(prev, bad) {
  const p = nextPenalty({ penalty: prev.on ? 1 : 0, strikes: prev.strikes, good: prev.good }, bad, !bad);
  return { on: p.penalty > 0, strikes: p.strikes, good: p.good };
}

export function pickTiers({ people, camCeiling, sendPenalty, screenPreset, slowUp = false, slowViewers = 0 }) {
  let cam = Math.max(camCeiling, camTierForGroup(people)) + sendPenalty;
  if (slowUp) cam = Math.max(cam, CAM_720P);
  cam = Math.min(CAM_TIERS.length - 1, cam);

  const screen = Math.min(SCREEN_TIERS.length - 1, sendPenalty);
  let scale = SCREEN_TIERS[screen].scale;
  let screenBitrate = screenBitrateForGroup(people, screenPreset.bitrate);
  const screenSlow = slowUp || slowViewers > 0;
  if (screenSlow) {
    scale = Math.max(scale, screenPreset.height / SLOW_NET_HEIGHT);
    screenBitrate = Math.min(screenBitrate, SLOW_NET_SCREEN_BITRATE);
  }
  return {
    cam,
    screenScale: scale,
    screenHeight: Math.round(screenPreset.height / scale),
    screenFps: Math.min(screenPreset.fps, SCREEN_TIERS[screen].fps),
    screenBitrate,
    screenSlow,
  };
}

/** Highest camera layer to receive: layer 1 of a 1080p camera is 540p, so 720p and below. */
export function maxRecvLayer({ slowDown, recvPenalty }) {
  return Math.max(0, (slowDown ? 1 : 2) - recvPenalty);
}

export class AutoQuality {
  /**
   * @param {object} o
   * @param {() => number} o.people
   * @param {(source: string) => any} o.producer  mediasoup-client Producer or undefined
   * @param {() => any[]} o.videoConsumers
   * @param {() => any} o.sendTransport
   * @param {() => any} o.recvTransport
   * @param {() => {camCeiling: number, screenPreset: object}} o.settings
   * @param {(info: object) => void} o.onChange
   * @param {(slow: boolean) => void} o.onSlowDownChange  tell the server our download is slow
   */
  constructor(o) {
    this.o = o;
    this.send = { penalty: 0, strikes: 0, good: 0 };
    this.recv = { penalty: 0, strikes: 0, good: 0 };
    this.slowUp = { on: false, strikes: 0, good: 0 };
    this.slowDown = { on: false, strikes: 0, good: 0 };
    this.slowViewers = 0; // other people in the room who reported slow download
    this.applied = new Map(); // producerId -> key of what we last applied
    this.prev = new Map(); // stats id -> previous counters
    this.timer = null;
  }

  start(intervalMs = 3000) {
    this.stop();
    this.timer = setInterval(() => this.tick().catch(() => {}), intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  reset() {
    this.applied.clear();
    this.prev.clear();
  }

  setSlowViewers(count) {
    this.slowViewers = count;
    this.apply();
  }

  get maxRecvLayer() {
    return maxRecvLayer({ slowDown: this.slowDown.on, recvPenalty: this.recv.penalty });
  }

  async tick() {
    const s = await this.sample();
    const before = this.maxRecvLayer;
    const wasSlowDown = this.slowDown.on;
    this.send = nextPenalty(this.send, s.sendCpu, !s.sendLimited);
    this.recv = nextPenalty(this.recv, s.decodeBad, !s.decodeBad);
    this.slowUp = nextFlag(this.slowUp, s.uplinkBad);
    this.slowDown = nextFlag(this.slowDown, s.downlinkBad);
    if (wasSlowDown !== this.slowDown.on) this.o.onSlowDownChange?.(this.slowDown.on);
    await this.apply(before !== this.maxRecvLayer);
  }

  delta(id, key, value) {
    const entry = this.prev.get(id) || {};
    const d = entry[key] == null ? 0 : value - entry[key];
    entry[key] = value;
    this.prev.set(id, entry);
    return d;
  }

  async sample() {
    let sendCpu = false;
    let sendLimited = false;
    let sendBandwidth = false;
    let sendingVideo = false;
    for (const source of ['cam', 'screen']) {
      const p = this.o.producer(source);
      if (!p || p.closed) continue;
      sendingVideo = true;
      (await p.getStats()).forEach((s) => {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
        if (s.qualityLimitationReason === 'cpu') sendCpu = true;
        if (s.qualityLimitationReason === 'bandwidth') sendBandwidth = true;
        if (s.qualityLimitationReason && s.qualityLimitationReason !== 'none') sendLimited = true;
      });
    }

    // The bandwidth estimate starts low and ramps up, so ignore the uplink for a while after video starts.
    if (!sendingVideo) this.videoSince = 0;
    else if (!this.videoSince) this.videoSince = Date.now();
    let uplinkBad = false;
    const st = this.o.sendTransport();
    if (sendingVideo && Date.now() - this.videoSince > WARMUP_MS && st && !st.closed) {
      let aob = 0;
      (await st.getStats()).forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
          aob = s.availableOutgoingBitrate || 0;
          if (s.currentRoundTripTime > MAX_RTT) uplinkBad = true;
        }
        if (s.type === 'remote-inbound-rtp' && s.fractionLost > MAX_LOSS) uplinkBad = true;
      });
      if (aob && aob < MIN_UPLINK) uplinkBad = true;
      // "bandwidth"-limited only means slow internet if the estimate is genuinely low too.
      if (sendBandwidth && aob && aob < 2 * MIN_UPLINK) uplinkBad = true;
    }

    let decoded = 0;
    let dropped = 0;
    let received = 0;
    let lost = 0;
    let freezes = 0;
    const seen = new Set();
    for (const c of this.o.videoConsumers()) {
      if (c.closed || c.paused) continue;
      seen.add(c.id);
      (await c.getStats()).forEach((s) => {
        if (s.type !== 'inbound-rtp') return;
        decoded += this.delta(c.id, 'decoded', s.framesDecoded || 0);
        dropped += this.delta(c.id, 'dropped', s.framesDropped || 0);
        received += this.delta(c.id, 'received', s.packetsReceived || 0);
        lost += Math.max(0, this.delta(c.id, 'lost', s.packetsLost || 0));
        freezes += this.delta(c.id, 'freezes', s.freezeCount || 0);
      });
    }
    let rttBad = false;
    const rt = this.o.recvTransport();
    if (rt && !rt.closed && seen.size) {
      (await rt.getStats()).forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && s.currentRoundTripTime > MAX_RTT) rttBad = true;
      });
    }
    for (const id of this.prev.keys()) if (!seen.has(id)) this.prev.delete(id);

    const decodeBad = decoded + dropped > 30 && dropped / (decoded + dropped) > 0.15;
    const downlinkBad = (received > 100 && lost / (received + lost) > MAX_LOSS) || freezes > 1 || rttBad;
    return { sendCpu, sendLimited, uplinkBad, decodeBad, downlinkBad };
  }

  /** Re-apply now (called on join/leave and when local video starts). */
  async apply(recvChanged = false) {
    const { camCeiling, screenPreset } = this.o.settings();
    const people = this.o.people();
    const t = pickTiers({
      people, camCeiling, screenPreset,
      sendPenalty: this.send.penalty,
      slowUp: this.slowUp.on,
      slowViewers: this.slowViewers,
    });

    const cam = this.o.producer('cam');
    if (cam && !cam.closed && this.applied.get(cam.id) !== `c${t.cam}`) {
      this.applied.set(cam.id, `c${t.cam}`);
      await applyCamTier(cam, CAM_TIERS[t.cam]);
    }
    const screen = this.o.producer('screen');
    const screenKey = `${t.screenScale}:${t.screenFps}:${t.screenBitrate}`;
    if (screen && !screen.closed && this.applied.get(screen.id) !== screenKey) {
      this.applied.set(screen.id, screenKey);
      await applyScreenTier(screen, t.screenScale, t.screenFps, t.screenBitrate);
    }

    let reason = '';
    if (this.slowUp.on) reason = 'your upload is slow, capped at 720p';
    else if (this.slowDown.on) reason = 'your download is slow, receiving at most 720p';
    else if (t.screenSlow && screen) reason = 'a viewer has slow internet, screen capped at 720p';
    else if (this.send.penalty) reason = 'your PC is busy encoding';
    else if (this.recv.penalty) reason = 'your PC is struggling to show everyone';

    this.o.onChange({
      cam: CAM_TIERS[t.cam].label,
      screen: `${t.screenHeight}p${t.screenFps}`,
      people,
      reason,
      slow: this.slowUp.on || this.slowDown.on,
      maxRecvLayer: this.maxRecvLayer,
      recvChanged,
    });
  }
}

async function applyCamTier(producer, tier) {
  await producer.track?.applyConstraints({
    width: { ideal: Math.round((tier.height * 16) / 9) },
    height: { ideal: tier.height },
    frameRate: { ideal: tier.fps },
  }).catch(() => {});
  await updateEncodings(producer, (encodings) => encodings.forEach((e, i) => {
    const share = SIMULCAST_SHARES[SIMULCAST_SHARES.length - encodings.length + i] ?? 1;
    e.maxBitrate = Math.round(tier.bitrate * share);
    e.maxFramerate = tier.fps;
  }));
}

async function applyScreenTier(producer, scale, fps, bitrate) {
  await updateEncodings(producer, (encodings) => encodings.forEach((e) => {
    e.maxBitrate = bitrate;
    e.maxFramerate = fps;
    e.scaleResolutionDownBy = scale;
  }));
}

async function updateEncodings(producer, mutate) {
  const sender = producer.rtpSender;
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    mutate(params.encodings);
    await sender.setParameters(params);
  } catch (err) {
    console.warn('could not change encoding:', err.message);
  }
}
