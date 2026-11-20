import { setupServer } from 'msw/node';

// Handlers are installed per test (server.use(...backend.handlers)).
export const server = setupServer();
