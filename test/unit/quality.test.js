import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAM_TIERS, camTierForGroup, screenBitrateForGroup, nextPenalty, nextFlag, pickTiers, maxRecvLayer,
} from '../../client/quality.js';

const P1080 = { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 };
const P1440 = { width: 2560, height: 1440, fps: 60, bitrate: 14_000_000 };
const cam = (o) => CAM_TIERS[pickTiers({ camCeiling: 0, sendPenalty: 0, screenPreset: P1080, ...o }).cam].label;

test('camera quality follows group size', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 10].map(camTierForGroup), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(cam({ people: 2 }), '1080p60');
  assert.equal(cam({ people: 4 }), '720p30');
  assert.equal(cam({ people: 10 }), '360p24');
});

test('user ceiling (data saver) is respected even in a 1-on-1', () => {
  assert.equal(cam({ people: 2, camCeiling: 1 }), '720p30');
});

test('screen bitrate splits the host budget but never drops below 3 Mbps', () => {
  assert.equal(screenBitrateForGroup(2, 8e6), 8e6);
  assert.equal(screenBitrateForGroup(5, 8e6), 8e6);
  assert.equal(screenBitrateForGroup(9, 8e6), 4e6);
  assert.equal(screenBitrateForGroup(10, 8e6), 3_555_556);
  assert.equal(screenBitrateForGroup(50, 8e6), 3e6);
});

test('penalty: one bad sample is ignored, two step down, recovery needs 10 good ones', () => {
  let s = { penalty: 0, strikes: 0, good: 0 };
  s = nextPenalty(s, true, false);
  assert.equal(s.penalty, 0);
  s = nextPenalty(s, true, false);
  assert.equal(s.penalty, 1);
  for (let i = 0; i < 9; i++) s = nextPenalty(s, false, true);
  assert.equal(s.penalty, 1);
  s = nextPenalty(s, false, true);
  assert.equal(s.penalty, 0);
});

test('penalty is capped and a non-healthy sample resets the recovery count', () => {
  let s = { penalty: 0, strikes: 0, good: 0 };
  for (let i = 0; i < 20; i++) s = nextPenalty(s, true, false);
  assert.equal(s.penalty, 2);
  for (let i = 0; i < 9; i++) s = nextPenalty(s, false, true);
  s = nextPenalty(s, false, false); // e.g. still bandwidth-limited
  for (let i = 0; i < 9; i++) s = nextPenalty(s, false, true);
  assert.equal(s.penalty, 2);
});

test('slow-internet flag flips on after 2 bad samples and off after 10 good ones', () => {
  let f = { on: false, strikes: 0, good: 0 };
  f = nextFlag(f, true);
  assert.equal(f.on, false);
  f = nextFlag(f, true);
  assert.equal(f.on, true);
  for (let i = 0; i < 9; i++) f = nextFlag(f, false);
  assert.equal(f.on, true);
  f = nextFlag(f, false);
  assert.equal(f.on, false);
});

test('slow upload caps camera and screen at 720p', () => {
  assert.equal(cam({ people: 2, slowUp: true }), '720p30');
  assert.equal(cam({ people: 8, slowUp: true }), '360p24'); // already below 720p: not raised
  const t = pickTiers({ people: 2, camCeiling: 0, sendPenalty: 0, screenPreset: P1080, slowUp: true });
  assert.equal(t.screenHeight, 720);
  assert.equal(t.screenFps, 60);
  assert.ok(t.screenBitrate <= 3_500_000);
});

test('a slow viewer caps the screen at 720p, from 1440p too', () => {
  const t = pickTiers({ people: 3, camCeiling: 0, sendPenalty: 0, screenPreset: P1440, slowViewers: 1 });
  assert.equal(t.screenHeight, 720);
  assert.equal(t.screenScale, 2);
  const normal = pickTiers({ people: 3, camCeiling: 0, sendPenalty: 0, screenPreset: P1440 });
  assert.equal(normal.screenHeight, 1440);
});

test('busy PC lowers screen fps before resolution', () => {
  const p1 = pickTiers({ people: 2, camCeiling: 0, sendPenalty: 1, screenPreset: P1080 });
  assert.deepEqual([p1.screenHeight, p1.screenFps], [1080, 30]);
  const p2 = pickTiers({ people: 2, camCeiling: 0, sendPenalty: 2, screenPreset: P1080 });
  assert.deepEqual([p2.screenHeight, p2.screenFps], [720, 30]);
});

test('receiving: slow download takes at most the middle camera layer', () => {
  assert.equal(maxRecvLayer({ slowDown: false, recvPenalty: 0 }), 2);
  assert.equal(maxRecvLayer({ slowDown: true, recvPenalty: 0 }), 1);
  assert.equal(maxRecvLayer({ slowDown: true, recvPenalty: 2 }), 0);
});
