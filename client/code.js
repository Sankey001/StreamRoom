// Meeting IDs: 6 characters like "K7P-2QX" (shown with a dash, typed with or without it).
// Crockford base32, so look-alikes (O/0, I/L/1) are read as the same character.
// 30 bits = the host's last IPv4 octet (8 bits) + 22 random bits. The octet lets a
// joiner's app find the host directly even when the network blocks broadcasts.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;

export function makeCode(lastOctet = Math.floor(Math.random() * 256)) {
  let value = ((lastOctet & 0xff) << 22) | Math.floor(Math.random() * (1 << 22));
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out = ALPHABET[value & 31] + out;
    value >>>= 5;
  }
  return out;
}

/** Uppercases, drops spaces/dashes and maps look-alikes. Returns '' if it isn't a valid code. */
export function normalizeCode(input) {
  const s = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  return s.length === CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : '';
}

export function codeOctet(code) {
  let value = 0;
  for (const c of code) value = value * 32 + ALPHABET.indexOf(c);
  return (value >>> 22) & 0xff;
}

export function formatCode(code) {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
