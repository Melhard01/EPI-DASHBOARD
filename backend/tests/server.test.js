/**
 * The real server entry point (src/server.js), run as a separate process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything that could pull in real settings is overridden explicitly.
const baseEnv = {
  PATH: process.env.PATH,
  NODE_ENV: 'development',
  DATABASE_URL: '',
  TEST_DATABASE_URL: '',
  AUTH_MODE: 'none',
  CLIENT_IP_SOURCE: 'socket',
  RATE_LIMIT_STORE: 'memory',
};

function run(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) } });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const done = (result) => resolve({ ...result, output, child });
    child.once('exit', (code) => done({ code, exited: true }));
    // A healthy server never exits by itself: give it a moment, then report it as still running.
    setTimeout(() => done({ code: null, exited: false }), 2500).unref();
  });
}

test('when the port is already in use, the server fails loudly instead of claiming to have started', async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, resolve));
  const { port } = blocker.address();
  try {
    const result = await run(port);
    assert.equal(result.exited, true, 'the process must exit');
    assert.equal(result.code, 1);
    assert.ok(!result.output.includes('server started'), result.output);
    assert.match(result.output, /server failed to start/);
    assert.match(result.output, /EADDRINUSE/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('on a free port the server starts and keeps running', async () => {
  const free = createServer();
  await new Promise((resolve) => free.listen(0, resolve));
  const { port } = free.address();
  await new Promise((resolve) => free.close(resolve));

  const result = await run(port);
  try {
    assert.equal(result.exited, false, result.output);
    assert.match(result.output, /server started/);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    result.child.kill('SIGTERM');
    await new Promise((resolve) => result.child.once('exit', resolve));
  }
});
