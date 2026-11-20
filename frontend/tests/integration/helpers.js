import { createPrivateKey, createSign } from 'node:crypto';
import { inject } from 'vitest';
import { configureClient } from '../../src/api/client.js';

// These two values are the backend's documented DEV constants (backend/src/app.js, DEV_ACCESS).
// They exist only for AUTH_MODE=dev; production tokens come from Cloudflare Access.
const DEV_ISSUER = 'https://dev-access.invalid';
const DEV_AUDIENCE = 'central-backend-local-development';

const b64url = (value) => Buffer.from(value).toString('base64url');

/** Signs a Cloudflare-Access-style token for `email` with the test key. */
export function signToken(email, { ttlSeconds = 3600, claims = {}, audience = DEV_AUDIENCE, issuer = DEV_ISSUER } = {}) {
  const key = createPrivateKey(inject('privateKeyPem'));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: inject('keyId') };
  const payload = { iss: issuer, aud: [audience], sub: `user-${email}`, email, iat: now, nbf: now, exp: now + ttlSeconds, ...claims };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
}

const CLIENT_IP = '203.0.113.10';

/**
 * Makes the frontend's API client talk to the real backend as `email`.
 * Browser-like headers: browsers always send Origin on requests that change
 * data, and Cloudflare adds the client address; Node does neither by itself.
 */
export function as(email, { token = signToken(email), origin = inject('origins').dashboard, ip = CLIENT_IP, headers = {} } = {}) {
  configureClient({
    baseUrl: inject('backendUrl'),
    onUnauthorized: null,
    headers: {
      ...(token ? { 'cf-access-jwt-assertion': token } : {}),
      ...(origin ? { origin } : {}),
      'cf-connecting-ip': ip,
      ...headers,
    },
  });
}

/** What a visitor's browser on one of the three websites does: POST a form. */
export async function submitForm(site, formType, fields, { ip, headers = {}, viaUnified = false } = {}) {
  const origins = inject('origins');
  const base = inject('backendUrl');
  const url = viaUnified ? `${base}/api/v1/submissions` : `${base}/api/v1/${site}/forms/${formType}`;
  const body = viaUnified ? { application: site, formType, data: fields } : fields;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: origins[site], 'cf-connecting-ip': ip ?? '198.51.100.20', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

/** Valid example submissions, one per form, using the live websites' field names. */
export const FORMS = {
  demo: { site: 'epineon', fields: (n) => ({ name: `Demo Person ${n}`, email: `demo${n}@epineon.test`, company: 'Acme', product: 'EPICRYPT', message: 'Show me reports' }) },
  sales: { site: 'epineon', fields: (n) => ({ name: `Sales Person ${n}`, email: `sales${n}@epineon.test`, company: 'Initech', product: 'SoulChain', useCase: 'Other', message: 'Pricing please' }) },
  partnerships: { site: 'epineon', fields: (n) => ({ name: `Partner ${n}`, email: `partner${n}@epineon.test`, organization: 'Umbrella', nature: 'Investment' }) },
  'contact-sales': { site: 'qaegis', fields: (n) => ({ firstName: 'Quinn', lastName: `Tester${n}`, workEmail: `quinn${n}@qaegis.test`, userRange: '51-250', message: 'Need SSO' }) },
  waitlist: { site: 'epiwell', fields: (n) => ({ email: `member${n}@epiwell.test` }) },
};

export const uniqueTag = () => `${inject('runId')}${Math.random().toString(36).slice(2, 7)}`;
