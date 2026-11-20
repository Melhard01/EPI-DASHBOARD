/**
 * Production build: proves that secrets which exist in the build environment
 * (database URLs, dev tokens, anything without the VITE_ prefix) can never end
 * up in the files served to browsers, while the intentionally public VITE_
 * settings do.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { build } from 'vite';

const frontendDir = path.resolve(import.meta.dirname, '../..');
const SECRETS = {
  DEV_ACCESS_TOKEN: 'SECRET-DEV-TOKEN-0123456789-abcdef',
  DATABASE_URL: 'postgresql://app_user:SUPERSECRETPASSWORD@db.internal.example/production?sslmode=verify-full',
  TEST_DATABASE_URL: 'postgresql://app_user:ANOTHERSECRETPASSWORD@db.internal.example/test',
  RATE_LIMIT_SECRET: 'SECRET-RATE-LIMIT-KEY-0123456789abcdef0123456789',
  ACCESS_AUD: 'SECRET-ACCESS-AUD-TAG-0123456789',
};
const PUBLIC = { VITE_API_BASE_URL: 'https://api.public-example.test', VITE_ACCESS_LOGOUT_URL: 'https://team.public-example.test/cdn-cgi/access/logout' };

let outDir;
let previousNodeEnv;
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
}
const text = () => files.map((f) => ({ file: path.relative(outDir, f), content: readFileSync(f, 'utf8') }));

beforeAll(async () => {
  // The test runner sets NODE_ENV=test, which would make Vite bundle React's development
  // code. Build exactly like `npm run build` does: as production.
  previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  Object.assign(process.env, SECRETS, PUBLIC);
  outDir = mkdtempSync(path.join(tmpdir(), 'frontend-build-'));
  await build({ root: frontendDir, configFile: path.join(frontendDir, 'vite.config.js'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  walk(outDir);
}, 120_000);

afterAll(() => {
  process.env.NODE_ENV = previousNodeEnv;
  for (const key of [...Object.keys(SECRETS), ...Object.keys(PUBLIC)]) delete process.env[key];
  rmSync(outDir, { recursive: true, force: true });
});

describe('production build', () => {
  test('produces the app: an index.html plus hashed scripts and styles, no source maps', () => {
    const names = files.map((f) => path.relative(outDir, f));
    expect(names).toContain('index.html');
    expect(names.some((n) => /^assets\/index-.*\.js$/.test(n))).toBe(true);
    expect(names.some((n) => /^assets\/index-.*\.css$/.test(n))).toBe(true);
    expect(names.some((n) => n.endsWith('.map'))).toBe(false);
  });

  test('no secret from the build environment appears anywhere in the output', () => {
    for (const { file, content } of text()) {
      for (const [name, value] of Object.entries(SECRETS)) {
        expect(content, `${file} contains ${name}`).not.toContain(value);
        expect(content, `${file} contains part of ${name}`).not.toContain(value.slice(0, 24));
      }
      expect(content, `${file} mentions a database URL`).not.toMatch(/postgres(ql)?:\/\//i);
      expect(content, `${file} mentions neondb`).not.toMatch(/neondb/i);
    }
  });

  test('the browser code holds no authentication machinery: no token header, no credential storage', () => {
    for (const { file, content } of text()) {
      if (!file.endsWith('.js')) continue;
      expect(content.toLowerCase(), file).not.toContain('cf-access-jwt-assertion');
      expect(content, file).not.toContain('DEV_ACCESS_TOKEN');
      expect(content, file).not.toMatch(/localStorage\.(set|get)Item\(["'](token|jwt|auth|password|secret)/i);
    }
  });

  test('intentionally public VITE_ settings ARE included (and are the only configuration the browser gets)', () => {
    const bundle = text().filter((t) => t.file.endsWith('.js')).map((t) => t.content).join('\n');
    expect(bundle).toContain(PUBLIC.VITE_API_BASE_URL);
    expect(bundle).toContain(PUBLIC.VITE_ACCESS_LOGOUT_URL);
  });

  test('index.html is CSP-friendly: only external scripts, no inline script bodies or handlers', () => {
    const html = text().find((t) => t.file === 'index.html').content;
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body.trim()).toBe('');
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).toMatch(/noindex/);
  });

  test('the theme script is a separate file, so a strict script-src \'self\' works', () => {
    expect(files.map((f) => path.relative(outDir, f))).toContain('theme-init.js');
  });

  test('the heavy chart library is split into lazily loaded chunks, not the entry bundle', () => {
    const entry = text().find((t) => /^assets\/index-.*\.js$/.test(t.file));
    expect(entry.content).not.toContain('recharts');
    expect(text().some((t) => /^assets\/DailyChart-.*\.js$/.test(t.file))).toBe(true);
    expect(statSync(path.join(outDir, entry.file)).size).toBeLessThan(500 * 1024);
  });
});
