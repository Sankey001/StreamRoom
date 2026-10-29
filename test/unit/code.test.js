import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCode, normalizeCode, codeOctet, formatCode, CODE_LENGTH } from '../../client/code.js';

test('codes are 6 unambiguous characters', () => {
  for (let i = 0; i < 2000; i++) {
    const c = makeCode();
    assert.equal(c.length, CODE_LENGTH);
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{6}$/); // no I, L, O, U
  }
});

test('every last octet survives encode -> decode', () => {
  for (let octet = 0; octet < 256; octet++) assert.equal(codeOctet(makeCode(octet)), octet);
});

test('codes are random enough not to collide on a LAN', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(makeCode(26));
  assert.ok(seen.size > 4990, `only ${seen.size} unique of 5000`);
});

test('typing is forgiving: case, dashes, spaces and look-alike letters', () => {
  const code = 'K7P2QX';
  for (const typed of ['k7p2qx', 'K7P-2QX', ' k7p 2qx ', 'K7P-2QX\n']) assert.equal(normalizeCode(typed), code);
  assert.equal(normalizeCode('1O0-ABC'), '100ABC'); // O -> 0
  assert.equal(normalizeCode('ILL-ABC'), '111ABC'); // I, L -> 1
});

test('invalid input is rejected, not guessed', () => {
  for (const bad of ['', 'K7P2Q', 'K7P2QXX', 'K7P#QX', null, undefined, 123, '<script>']) assert.equal(normalizeCode(bad), '');
});

test('display format', () => {
  assert.equal(formatCode('K7P2QX'), 'K7P-2QX');
});
