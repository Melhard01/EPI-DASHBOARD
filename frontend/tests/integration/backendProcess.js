/**
 * Starts the REAL backend as a separate process (the way it runs in development),
 * waits until it answers, and stops it afterwards. The frontend never imports
 * backend code: the two applications only meet over HTTP.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * @param {{ backendDir: string, env: Record<string, string> }} options
 *   `env` is the COMPLETE environment of the backend process (nothing is inherited
 *   except PATH), so a developer's own .env values or shell variables can never leak in.
 */
export async function startBackend({ backendDir, env }) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: { PATH: process.env.PATH, ...env, PORT: String(port), REQUEST_LOGGING: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) throw new Error(`Backend exited during startup:\n${output.join('').slice(-1500)}`);
    try {
      // Behind Cloudflare every request carries the client address; the backend insists on it.
      const res = await fetch(`${url}/api/health`, { headers: { 'cf-connecting-ip': '203.0.113.1' }, signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`Backend did not start in time:\n${output.join('').slice(-1500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return {
    url,
    port,
    output: () => output.join(''),
    stop: () =>
      new Promise((resolve) => {
        if (exited) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        return undefined;
      }),
  };
}
