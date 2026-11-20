/**
 * Dependency-free IP address utilities: strict parsing, CIDR matching and
 * rate-limit normalization.
 *
 * Written without `node:net` so the same code runs unchanged on Node.js and
 * on Cloudflare Workers.
 */

const IPV4_PART = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** Parses dotted-quad IPv4 into a BigInt, or null if invalid. */
function parseIPv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((p) => IPV4_PART.test(p))) return null;
  return parts.reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
}

/** Parses IPv6 (incl. "::" and embedded IPv4) into a BigInt, or null if invalid. */
function parseIPv6(text) {
  if (text.includes('%')) return null; // zone IDs are never valid client addresses
  let head = text;
  let tailIPv4 = null;

  const lastColon = text.lastIndexOf(':');
  if (text.includes('.') && lastColon !== -1) {
    tailIPv4 = parseIPv4(text.slice(lastColon + 1));
    if (tailIPv4 === null) return null;
    head = `${text.slice(0, lastColon + 1)}0:0`;
  }

  const doubleColon = head.split('::');
  if (doubleColon.length > 2) return null;

  const toGroups = (s) => (s === '' ? [] : s.split(':'));
  const left = toGroups(doubleColon[0]);
  const right = doubleColon.length === 2 ? toGroups(doubleColon[1]) : [];
  const missing = 8 - left.length - right.length;
  if (doubleColon.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...left, ...Array(doubleColon.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;

  let value = groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
  if (tailIPv4 !== null) value = (value & ~0xffffffffn) | tailIPv4;
  return value;
}

/**
 * Parses an IP address string.
 * @returns {{ version: 4|6, value: bigint } | null}
 */
export function parseIp(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 45) return null;
  const v4 = parseIPv4(text);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIPv6(text);
  if (v6 !== null) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as the IPv4 address.
    if (v6 >> 32n === 0xffffn) return { version: 4, value: v6 & 0xffffffffn };
    return { version: 6, value: v6 };
  }
  return null;
}

/** Compiles CIDR strings into a fast matcher. Throws on invalid input. */
export function createCidrMatcher(cidrs) {
  const ranges = cidrs.map((cidr) => {
    const [addr, bitsText] = cidr.split('/');
    const ip = parseIp(addr);
    const maxBits = ip?.version === 4 ? 32 : 128;
    const bits = Number(bitsText);
    if (!ip || !Number.isInteger(bits) || bits < 0 || bits > maxBits) {
      throw new Error(`Invalid CIDR: ${cidr}`);
    }
    const shift = BigInt(maxBits - bits);
    return { version: ip.version, shift, network: ip.value >> shift };
  });

  return function matches(ipText) {
    const ip = parseIp(ipText);
    if (!ip) return false;
    return ranges.some((r) => r.version === ip.version && ip.value >> r.shift === r.network);
  };
}

function formatIPv4(value) {
  return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 0xffn)).join('.');
}

/**
 * Canonical identifier used for rate limiting:
 *   IPv4 → "v4:a.b.c.d"
 *   IPv6 → "v6:<first 64 bits>::/64"  (one subscriber typically owns a /64,
 *          so per-address limits would be trivially bypassed)
 * Returns null for invalid input.
 */
export function rateLimitSubject(ipText) {
  const ip = parseIp(ipText);
  if (!ip) return null;
  if (ip.version === 4) return `v4:${formatIPv4(ip.value)}`;
  const prefix = (ip.value >> 64n).toString(16).padStart(16, '0');
  return `v6:${prefix}::/64`;
}
