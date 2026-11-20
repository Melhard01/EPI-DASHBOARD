/**
 * Cloudflare Access JWT verification: the gate to the whole admin API.
 * Every rejection path is exercised, including forged and tampered tokens.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  createAccessVerifier,
  AccessTokenError,
  normalizeTeamDomain,
} from '../src/shared/security/cloudflareAccess.js';
import { createAccessKeyPair, signAccessToken } from '../scripts/lib/access-token.js';

const TEAM = 'https://acme.cloudflareaccess.com';
const AUD = 'aud-tag-0123456789abcdef0123456789abcdef';
const b64url = (v) => Buffer.from(v).toString('base64url');

function setup({ now } = {}) {
  const key = createAccessKeyPair('key-1');
  let jwks = key.jwks;
  let fetches = 0;
  const verify = createAccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    fetchJwks: async () => {
      fetches += 1;
      if (jwks instanceof Error) throw jwks;
      return jwks;
    },
    ...(now ? { now } : {}),
  });
  return {
    key,
    verify,
    fetches: () => fetches,
    setJwks: (value) => {
      jwks = value;
    },
    token: (email = 'Admin@Example.com', extra = {}) =>
      signAccessToken({ email, teamDomain: TEAM, audience: AUD, key, ...extra }),
  };
}

async function rejects(promise, reason) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AccessTokenError, `expected AccessTokenError, got ${err}`);
    assert.equal(err.reason, reason);
    return true;
  });
}

describe('valid tokens', () => {
  test('are accepted and the email is normalized to lower case', async () => {
    const { verify, token } = setup();
    const identity = await verify(token('Admin@Example.com'));
    assert.equal(identity.email, 'admin@example.com');
  });

  test('accept an audience list that contains our tag', async () => {
    const { verify, token } = setup();
    const t = token('a@example.com', { claims: { aud: ['someone-else', AUD] } });
    assert.equal((await verify(t)).email, 'a@example.com');
  });

  test('tolerate small clock skew (within 60 s)', async () => {
    const { verify, token } = setup();
    const now = Math.floor(Date.now() / 1000);
    assert.ok(await verify(token('a@example.com', { claims: { exp: now - 30 } })));
    assert.ok(await verify(token('a@example.com', { claims: { nbf: now + 30 } })));
  });
});

describe('forged and tampered tokens', () => {
  test('a token signed by a different key (same kid) is rejected', async () => {
    const { verify } = setup();
    const attacker = createAccessKeyPair('key-1');
    const forged = signAccessToken({ email: 'admin@example.com', teamDomain: TEAM, audience: AUD, key: attacker });
    await rejects(verify(forged), 'bad_signature');
  });

  test('changing the payload after signing invalidates the token', async () => {
    const { verify, token } = setup();
    const [h, , s] = token('low@example.com').split('.');
    const payload = JSON.parse(Buffer.from(token('low@example.com').split('.')[1], 'base64url'));
    payload.email = 'boss@example.com';
    await rejects(verify(`${h}.${b64url(JSON.stringify(payload))}.${s}`), 'bad_signature');
  });

  test('"alg": "none" is rejected', async () => {
    const { verify } = setup();
    const head = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'key-1' }));
    const body = b64url(JSON.stringify({ iss: TEAM, aud: [AUD], email: 'a@example.com', exp: 9_999_999_999 }));
    // Rejected on the header alone, before the signature is even looked at.
    await rejects(verify(`${head}.${body}.`), 'bad_algorithm');
    await rejects(verify(`${head}.${body}.AAAA`), 'bad_algorithm');
  });

  test('HS256 "algorithm confusion" (public key used as an HMAC secret) is rejected', async () => {
    const { verify, key } = setup();
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'key-1' }));
    const body = b64url(JSON.stringify({ iss: TEAM, aud: [AUD], email: 'a@example.com', exp: 9_999_999_999 }));
    const secret = JSON.stringify(key.jwks.keys[0]);
    const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
    await rejects(verify(`${head}.${body}.${sig}`), 'bad_algorithm');
  });

  test('an unknown key ID is rejected', async () => {
    const { verify } = setup();
    const other = createAccessKeyPair('other-key');
    await rejects(
      verify(signAccessToken({ email: 'a@example.com', teamDomain: TEAM, audience: AUD, key: other })),
      'unknown_key',
    );
  });
});

describe('claim checks (after a valid signature)', () => {
  test('wrong issuer', async () => {
    const { verify, token } = setup();
    await rejects(verify(token('a@example.com', { claims: { iss: 'https://evil.cloudflareaccess.com' } })), 'bad_issuer');
    await rejects(verify(token('a@example.com', { claims: { iss: `${TEAM}/` } })), 'bad_issuer');
  });

  test('wrong, missing or foreign audience', async () => {
    const { verify, token } = setup();
    await rejects(verify(token('a@example.com', { claims: { aud: ['another-app'] } })), 'bad_audience');
    await rejects(verify(token('a@example.com', { claims: { aud: 'another-app' } })), 'bad_audience');
    await rejects(verify(token('a@example.com', { claims: { aud: undefined } })), 'bad_audience');
  });

  test('expired tokens (beyond the leeway)', async () => {
    const { verify, token } = setup();
    const now = Math.floor(Date.now() / 1000);
    await rejects(verify(token('a@example.com', { claims: { exp: now - 120 } })), 'expired');
    await rejects(verify(token('a@example.com', { claims: { exp: undefined } })), 'expired');
    await rejects(verify(token('a@example.com', { claims: { exp: 'tomorrow' } })), 'expired');
  });

  test('tokens that are not yet valid', async () => {
    const { verify, token } = setup();
    const now = Math.floor(Date.now() / 1000);
    await rejects(verify(token('a@example.com', { claims: { nbf: now + 300 } })), 'not_yet_valid');
  });

  test('tokens without an email (e.g. service tokens) are refused', async () => {
    const { verify, token } = setup();
    await rejects(verify(token('x@example.com', { claims: { email: undefined, common_name: 'svc.access' } })), 'no_email');
    await rejects(verify(token('x@example.com', { claims: { email: 'not-an-email' } })), 'no_email');
    await rejects(verify(token('x@example.com', { claims: { email: 42 } })), 'no_email');
  });
});

describe('malformed input', () => {
  test('missing, empty, oversized and structurally invalid tokens', async () => {
    const { verify } = setup();
    await rejects(verify(undefined), 'missing');
    await rejects(verify(''), 'missing');
    await rejects(verify('a.b'), 'malformed');
    await rejects(verify('a.b.c.d'), 'malformed');
    await rejects(verify('a'.repeat(9000)), 'malformed');
    await rejects(verify('###.###.###'), 'malformed');
    await rejects(verify(`${b64url('not json')}.${b64url('{}')}.AAAA`), 'malformed');
    await rejects(verify(`${b64url('[]')}.${b64url('{}')}.AAAA`), 'malformed');
    await rejects(verify(`${b64url('{"alg":"RS256"}')}.${b64url('{}')}.AAAA`), 'malformed'); // no kid
  });

  test('rejection errors never contain the token', async () => {
    const { verify, token } = setup();
    const t = token('secret.person@example.com', { claims: { exp: 1 } });
    await assert.rejects(verify(t), (err) => {
      assert.ok(!err.message.includes(t));
      assert.ok(!err.message.includes('secret.person'));
      return true;
    });
  });
});

describe('key set handling', () => {
  test('keys are cached between verifications', async () => {
    const { verify, token, fetches } = setup();
    await verify(token());
    await verify(token());
    await verify(token());
    assert.equal(fetches(), 1);
  });

  test('a rotated-in key is picked up when its kid first appears', async () => {
    let clock = Date.now();
    const { verify, key, setJwks, fetches } = setup({ now: () => clock });
    await verify(signAccessToken({ email: 'a@example.com', teamDomain: TEAM, audience: AUD, key }));

    const rotated = createAccessKeyPair('key-2');
    setJwks({ keys: [...key.jwks.keys, ...rotated.jwks.keys] });
    clock += 60_000; // past the refetch throttle
    const identity = await verify(signAccessToken({ email: 'b@example.com', teamDomain: TEAM, audience: AUD, key: rotated }));
    assert.equal(identity.email, 'b@example.com');
    assert.equal(fetches(), 2);
  });

  test('unknown key IDs cannot be used to hammer the certs endpoint', async () => {
    let clock = Date.now();
    const { verify, fetches } = setup({ now: () => clock });
    for (let i = 0; i < 20; i++) {
      const stranger = createAccessKeyPair(`random-${i}`);
      await rejects(
        verify(signAccessToken({ email: 'a@example.com', teamDomain: TEAM, audience: AUD, key: stranger })),
        'unknown_key',
      );
    }
    assert.ok(fetches() <= 2, `fetched ${fetches()} times`);
    clock += 31_000;
    await rejects(
      verify(signAccessToken({ email: 'a@example.com', teamDomain: TEAM, audience: AUD, key: createAccessKeyPair('again') })),
      'unknown_key',
    );
    assert.ok(fetches() <= 3);
  });

  test('if the certs endpoint is down and nothing is cached, verification fails closed', async () => {
    const { verify, token, setJwks } = setup();
    setJwks(new Error('network down'));
    await rejects(verify(token()), 'jwks_unavailable');
  });

  test('if the certs endpoint goes down later, cached keys keep working', async () => {
    let clock = Date.now();
    const { verify, token, setJwks } = setup({ now: () => clock });
    const longLived = token('a@example.com', { ttlSeconds: 6 * 3600 });
    await verify(longLived);
    setJwks(new Error('network down'));
    clock += 2 * 3_600_000; // cache expired → refetch attempted and fails
    assert.ok(await verify(longLived));
  });

  test('a JWKS with no usable RS256 keys is never accepted', async () => {
    const { verify, token, setJwks } = setup();
    setJwks({ keys: [{ kty: 'oct', kid: 'key-1', k: 'AAAA' }, { kty: 'RSA', kid: 'x', alg: 'RS512', n: 'AQAB', e: 'AQAB' }] });
    await rejects(verify(token()), 'jwks_unavailable');
  });
});

describe('configuration', () => {
  test('team domains must be https origins', () => {
    assert.equal(normalizeTeamDomain('https://acme.cloudflareaccess.com/'), TEAM);
    for (const bad of ['http://acme.cloudflareaccess.com', 'https://acme.cloudflareaccess.com/path', 'acme', 'https://a.com?x=1']) {
      assert.throws(() => normalizeTeamDomain(bad), undefined, bad);
    }
  });

  test('an audience tag is required', () => {
    assert.throws(() => createAccessVerifier({ teamDomain: TEAM, audience: '' }), /AUD/);
    assert.throws(() => createAccessVerifier({ teamDomain: TEAM, audience: 'short' }), /AUD/);
  });
});
