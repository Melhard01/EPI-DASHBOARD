/**
 * Vercel entry point.
 *
 * Vercel runs this file as one Node.js function. vercel.json rewrites every
 * /api/* request to it, and Express then routes by the original URL, exactly as
 * it does under `npm start` (src/server.js, which is only for local development).
 *
 * The app is built once per function instance and reused across warm invocations,
 * which also reuses the single lazily-created Neon connection pool (see
 * src/shared/database). Nothing here listens on a port.
 *
 * Misconfiguration fails closed: createApp() throws in production when HTTPS,
 * rate limiting, the Cloudflare client-IP source or Cloudflare Access is missing,
 * so a bad deployment answers every request with an error instead of running unprotected.
 */
import { createApp } from '../src/app.js';

export default createApp();
