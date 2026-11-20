import { defineConfig } from 'vitest/config';

// Integration tests: the real API client against the REAL backend (started by
// globalSetup on a free port, using the dedicated test database).
// Run with:  INTEGRATION_DATABASE_URL=... npm run test:integration
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.js'],
    globalSetup: ['./tests/integration/globalSetup.js'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
