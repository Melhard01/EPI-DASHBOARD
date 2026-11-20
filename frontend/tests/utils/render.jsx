import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import App from '../../src/App.jsx';
import { createQueryClient } from '../../src/queryClient.js';
import { server } from '../msw/server.js';
import { createFakeBackend } from '../msw/fakeBackend.js';

/** Shows the current URL so tests can assert on navigation and URL-held state. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

/**
 * Renders the whole dashboard against the in-memory fake backend.
 * @param {{ route?: string, backend?: ReturnType<typeof createFakeBackend>, admin?: any }} options
 */
export function renderApp({ route = '/', backend, admin = 'superAdmin' } = {}) {
  const fake = backend ?? createFakeBackend({ admin });
  server.use(...fake.handlers);
  const user = userEvent.setup();
  const result = render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[route]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, user, backend: fake, location: () => document.querySelector('[data-testid="location"]').textContent };
}
