/**
 * Trusted client IP resolution.
 *
 * Forwarding headers are only as trustworthy as whoever set them, so the
 * source of the client IP is an explicit deployment setting:
 *
 *   socket            Local development and tests. Uses the TCP peer address.
 *                     All forwarding headers are ignored.
 *
 *   cloudflare-worker The app runs inside Cloudflare Workers. Cloudflare's edge
 *                     sets CF-Connecting-IP, and nothing can reach the Worker
 *                     without passing through that edge.
 *
 *   cloudflare-proxy  The app is a Node.js origin behind Cloudflare's proxy.
 *                     CF-Connecting-IP is trusted ONLY when the TCP peer is a
 *                     Cloudflare edge IP. Anything else is rejected.
 *
 * X-Forwarded-For, X-Real-IP and True-Client-IP are never used: clients can
 * prepend arbitrary values to X-Forwarded-For.
 */
import { AppError } from '../utils/AppError.js';
import { parseIp, createCidrMatcher } from './ipAddress.js';
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } from './cloudflareIpRanges.js';

export const ClientIpSource = Object.freeze({
  SOCKET: 'socket',
  CLOUDFLARE_WORKER: 'cloudflare-worker',
  CLOUDFLARE_PROXY: 'cloudflare-proxy',
});

export const CLIENT_IP_SOURCES = Object.freeze(Object.values(ClientIpSource));

const isCloudflareEdge = createCidrMatcher([...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES]);

function singleHeader(req, name) {
  const value = req.headers[name];
  // Duplicate headers arrive as arrays (or comma-joined); both are suspicious.
  if (typeof value !== 'string' || value.includes(',')) return null;
  return value.trim();
}

/** True if the request reached us through Cloudflare (per the configured mode). */
export function isFromTrustedProxy(req, source) {
  if (source === ClientIpSource.CLOUDFLARE_WORKER) return true;
  if (source === ClientIpSource.CLOUDFLARE_PROXY) {
    return isCloudflareEdge(req.socket?.remoteAddress ?? '');
  }
  return false;
}

/**
 * Returns the verified client IP for the request, or throws an AppError.
 * Never returns a value taken from an untrusted header.
 */
export function resolveClientIp(req, source) {
  if (source === ClientIpSource.SOCKET) {
    const peer = req.socket?.remoteAddress;
    if (!parseIp(peer ?? '')) throw new AppError('Unable to identify client', 400);
    return peer;
  }

  if (!CLIENT_IP_SOURCES.includes(source)) {
    throw new Error(`Unknown client IP source: ${source}`);
  }

  if (!isFromTrustedProxy(req, source)) {
    // A direct hit on the origin that bypassed Cloudflare.
    throw new AppError('Forbidden', 403);
  }

  const ip = singleHeader(req, 'cf-connecting-ip');
  if (!ip || !parseIp(ip)) {
    throw new AppError('Unable to identify client', 400);
  }
  return ip;
}

/**
 * True if the original client connection used HTTPS.
 * Forwarded protocol information is trusted only from Cloudflare, which
 * overwrites any client-supplied X-Forwarded-Proto.
 */
export function isSecureRequest(req, source) {
  if (req.socket?.encrypted === true) return true;
  if (source === ClientIpSource.SOCKET || !isFromTrustedProxy(req, source)) return false;
  return singleHeader(req, 'x-forwarded-proto')?.toLowerCase() === 'https';
}
