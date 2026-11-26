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
 *   vercel-cloudflare The app runs on Vercel with Cloudflare proxying in front.
 *                     Vercel terminates the connection, so the TCP peer is
 *                     Vercel's, not Cloudflare's. Instead, the connecting peer is
 *                     read from X-Vercel-Forwarded-For, which Vercel sets itself
 *                     and clients cannot override. CF-Connecting-IP is trusted
 *                     ONLY when that peer is a Cloudflare edge IP (so a direct hit
 *                     on the *.vercel.app address is rejected), AND, when an origin
 *                     secret is configured, the request carries it in X-Origin-Auth
 *                     (a Cloudflare Transform Rule adds it), so that another
 *                     Cloudflare customer cannot reach the origin through their own
 *                     Cloudflare account.
 *
 * X-Forwarded-For, X-Real-IP and True-Client-IP are never used: clients can
 * prepend arbitrary values to X-Forwarded-For.
 */
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../utils/AppError.js';
import { parseIp, createCidrMatcher } from './ipAddress.js';
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } from './cloudflareIpRanges.js';

export const ClientIpSource = Object.freeze({
  SOCKET: 'socket',
  CLOUDFLARE_WORKER: 'cloudflare-worker',
  CLOUDFLARE_PROXY: 'cloudflare-proxy',
  VERCEL_CLOUDFLARE: 'vercel-cloudflare',
});

/** Header Cloudflare adds (Transform Rule) to prove the request came through our zone. */
export const ORIGIN_AUTH_HEADER = 'x-origin-auth';

export const CLIENT_IP_SOURCES = Object.freeze(Object.values(ClientIpSource));

const isCloudflareEdge = createCidrMatcher([...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES]);

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  // Equal lengths are required by timingSafeEqual; a length mismatch is already a mismatch.
  return left.length === right.length && timingSafeEqual(left, right);
}

function singleHeader(req, name) {
  const value = req.headers[name];
  // Duplicate headers arrive as arrays (or comma-joined); both are suspicious.
  if (typeof value !== 'string' || value.includes(',')) return null;
  return value.trim();
}

/**
 * True if the request reached us through Cloudflare (per the configured mode).
 * @param {{ originSecret?: string|null }} [options] vercel-cloudflare only: the shared
 *   secret Cloudflare adds in X-Origin-Auth. When set, requests without it are untrusted.
 */
export function isFromTrustedProxy(req, source, options = {}) {
  if (source === ClientIpSource.CLOUDFLARE_WORKER) return true;
  if (source === ClientIpSource.CLOUDFLARE_PROXY) {
    return isCloudflareEdge(req.socket?.remoteAddress ?? '');
  }
  if (source === ClientIpSource.VERCEL_CLOUDFLARE) {
    const peer = singleHeader(req, 'x-vercel-forwarded-for');
    if (!peer || !isCloudflareEdge(peer)) return false;
    if (options.originSecret) {
      const presented = singleHeader(req, ORIGIN_AUTH_HEADER);
      if (!presented || !constantTimeEqual(presented, options.originSecret)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Returns the verified client IP for the request, or throws an AppError.
 * Never returns a value taken from an untrusted header.
 */
export function resolveClientIp(req, source, options = {}) {
  if (source === ClientIpSource.SOCKET) {
    const peer = req.socket?.remoteAddress;
    if (!parseIp(peer ?? '')) throw new AppError('Unable to identify client', 400);
    return peer;
  }

  if (!CLIENT_IP_SOURCES.includes(source)) {
    throw new Error(`Unknown client IP source: ${source}`);
  }

  if (!isFromTrustedProxy(req, source, options)) {
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
export function isSecureRequest(req, source, options = {}) {
  if (req.socket?.encrypted === true) return true;
  // Allow SOCKET source on Vercel: check x-forwarded-proto header for HTTPS
  if (source === ClientIpSource.SOCKET) {
    return singleHeader(req, 'x-forwarded-proto')?.toLowerCase() === 'https';
  }
  if (!isFromTrustedProxy(req, source, options)) return false;
  return singleHeader(req, 'x-forwarded-proto')?.toLowerCase() === 'https';
}
