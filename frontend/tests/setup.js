import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from './msw/server.js';
import { configureClient } from '../src/api/client.js';
import { BASE } from './msw/fakeBackend.js';

// jsdom has no ResizeObserver (used by the charting library).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Any request without a matching handler is a test bug, not something to ignore.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  // Node's fetch needs an absolute URL; production uses the dashboard's own origin.
  configureClient({ baseUrl: BASE, headers: {}, onUnauthorized: null });
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());
