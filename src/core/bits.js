// Bit-level value representation.
// A "value" is an array of bit-states, one per bit of a pin's width, LSB first (index 0 = bit 0).
// Each bit-state is one of: 0, 1, null (floating/unconnected), 'X' (conflict / short circuit)

export const LOW = 0;
export const HIGH = 1;
export const FLOATING = null;
export const CONFLICT = 'X';

export function makeFloating(width) {
  return new Array(width).fill(FLOATING);
}

export function fromInt(value, width) {
  const out = new Array(width);
  for (let i = 0; i < width; i++) out[i] = (value >>> i) & 1;
  return out;
}

export function toInt(bits) {
  let v = 0;
  for (let i = bits.length - 1; i >= 0; i--) {
    const b = bits[i];
    if (b !== 0 && b !== 1) return null; // not representable as a clean integer
    v = (v << 1) | b;
  }
  return v >>> 0;
}

export function isFullyDefined(bits) {
  return bits.every((b) => b === 0 || b === 1);
}

export function bitToChar(b) {
  if (b === 1) return '1';
  if (b === 0) return '0';
  if (b === CONFLICT) return 'X';
  return '?';
}

export function bitsToBinaryString(bits) {
  return bits.map(bitToChar).reverse().join('');
}

export function bitsToHexString(bits) {
  const v = toInt(bits);
  if (v === null) return bits.some((b) => b === CONFLICT) ? 'ERR' : '?'.repeat(Math.ceil(bits.length / 4));
  const digits = Math.max(1, Math.ceil(bits.length / 4));
  return v.toString(16).toUpperCase().padStart(digits, '0');
}

export function bitsToDecString(bits) {
  const v = toInt(bits);
  if (v === null) return bits.some((b) => b === CONFLICT) ? 'ERR' : '?';
  return String(v);
}

// Combine two drivers on the same net (used when detecting short circuits, not normally
// needed since wires have exactly one source, but kept for tunnels which can have many sources).
export function combineBit(a, b) {
  if (a === FLOATING) return b;
  if (b === FLOATING) return a;
  if (a === b) return a;
  return CONFLICT;
}

export function combineBits(a, b) {
  const len = Math.max(a.length, b.length);
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = combineBit(a[i] ?? FLOATING, b[i] ?? FLOATING);
  }
  return out;
}

export function equalBits(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function anyHigh(bits) {
  return bits.some((b) => b === 1);
}

export function anyConflict(bits) {
  return bits.some((b) => b === CONFLICT);
}

export function anyFloating(bits) {
  return bits.some((b) => b === FLOATING);
}
