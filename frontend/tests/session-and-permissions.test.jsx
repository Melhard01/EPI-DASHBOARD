/**
 * Session states, protected routes and permission-dependent navigation.
 * The UI only decides what to SHOW; the (fake) backend refuses the rest, exactly
 * like the real one, so both layers are checked.
 */
import { describe, test, expect } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server.js';
import { renderApp } from './utils/render.jsx';
import { BASE, createFakeBackend } from './msw/fakeBackend.js';

const ME = `${BASE}/api/v1/admin/me`;

describe('session states', () => {
  test('shows a loading state while the account loads', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers, http.get(ME, () => new Promise(() => {})));
    renderApp({ backend: { ...backend, handlers: [] } });
    expect(await screen.findByRole('status')).toHaveTextContent('Loading dashboard…');
  });

  test('no session (401): asks the user to sign in again, and shows nothing else', async () => {
    renderApp({ admin: null });
    expect(await screen.findByRole('heading', { name: 'Please sign in again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  test('a valid identity that is not an administrator (403) sees "No access" and no dashboard', async () => {
    renderApp({ admin: 'disabled' });
    expect(await screen.findByRole('heading', { name: 'No access to this dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  test('a server error shows a retry that recovers', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers);
    server.use(http.get(ME, () => HttpResponse.json({ status: 'error', message: 'Internal Server Error' }, { status: 500 }), { once: true }));
    const { user } = renderApp({ backend: { ...backend, handlers: [] } });
    expect(await screen.findByText('Cannot load your account')).toBeInTheDocument();
    expect(screen.getByText('Internal Server Error')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  test('a network failure shows a friendly message, not a stack trace', async () => {
    server.use(http.get(ME, () => HttpResponse.error()));
    renderApp({ backend: { handlers: [] } });
    expect(await screen.findByText(/cannot reach the server/i)).toBeInTheDocument();
  });
});

describe('protected routes', () => {
  test('an admin of one website cannot open another website\'s page — and no data is requested', async () => {
    const { backend } = renderApp({ admin: 'epineonAdmin', route: '/apps/qaegis/contact-sales' });
    expect(await screen.findByText('You do not have access to this website.')).toBeInTheDocument();
    expect(screen.queryByText('Quinn Alpha')).not.toBeInTheDocument();
    expect(backend.requests('/submissions')).toHaveLength(0);
  });

  test('a form that does not exist in a permitted website is "not found"', async () => {
    const { backend } = renderApp({ admin: 'epineonAdmin', route: '/apps/epineon/waitlist' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(backend.requests('/submissions')).toHaveLength(0);
  });

  test('a permitted form page loads its own submissions', async () => {
    renderApp({ admin: 'epineonAdmin', route: '/apps/epineon/demo' });
    expect(await screen.findByRole('heading', { name: 'Epineon · Demo' })).toBeInTheDocument();
    expect(await screen.findByText('Alice Epineon')).toBeInTheDocument();
  });

  test.each(['/team', '/audit'])('%s is Super Admin only: others see "not allowed" and no request is made', async (route) => {
    const { backend } = renderApp({ admin: 'epineonAdmin', route });
    expect(await screen.findByText('Only Super Admins can open this page.')).toBeInTheDocument();
    expect(backend.requests('/users')).toHaveLength(0);
    expect(backend.requests('/audit')).toHaveLength(0);
  });

  test('a Super Admin can open the team and audit pages', async () => {
    renderApp({ route: '/team' });
    expect(await screen.findByRole('heading', { name: 'Team management' })).toBeInTheDocument();
  });

  test('unknown routes show "Page not found"', async () => {
    renderApp({ route: '/no/such/page' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('navigation shows only what the admin may use', () => {
  const nav = async () => within(await screen.findByRole('navigation', { name: 'Main' }));

  test('Super Admin: every website and form, team, audit and settings', async () => {
    renderApp({ admin: 'superAdmin' });
    const menu = await nav();
    for (const name of ['Epineon', 'QAegis', 'Epi Well']) expect(menu.getByText(name)).toBeInTheDocument();
    for (const name of ['Demo', 'Sales', 'Partnerships', 'Contact Sales', 'Waitlist', 'Team management', 'Audit logs', 'Settings', 'Overview', 'All submissions']) {
      expect(menu.getByRole('link', { name })).toBeInTheDocument();
    }
    expect(menu.getByRole('link', { name: 'Contact Sales' })).toHaveAttribute('href', '/apps/qaegis/contact-sales');
    expect(menu.getByRole('link', { name: 'Waitlist' })).toHaveAttribute('href', '/apps/epiwell/waitlist');
    expect(screen.getAllByText('Super Admin').length).toBeGreaterThan(0);
  });

  test('Epineon admin: only Epineon — nothing of the other websites, no team or audit', async () => {
    renderApp({ admin: 'epineonAdmin' });
    const menu = await nav();
    for (const name of ['Demo', 'Sales', 'Partnerships', 'Settings']) expect(menu.getByRole('link', { name })).toBeInTheDocument();
    for (const gone of ['QAegis', 'Epi Well', 'Contact Sales', 'Waitlist']) expect(screen.queryByText(gone)).not.toBeInTheDocument();
    expect(menu.queryByRole('link', { name: 'Team management' })).not.toBeInTheDocument();
    expect(menu.queryByRole('link', { name: 'Audit logs' })).not.toBeInTheDocument();
    expect(screen.getByText('Website admin')).toBeInTheDocument();
  });

  test('QAegis admin: only QAegis', async () => {
    renderApp({ admin: 'qaegisAdmin' });
    const menu = await nav();
    expect(menu.getByRole('link', { name: 'Contact Sales' })).toBeInTheDocument();
    expect(screen.queryByText('Epineon')).not.toBeInTheDocument();
    expect(screen.queryByText('Epi Well')).not.toBeInTheDocument();
  });

  test('an admin with two websites sees exactly those two', async () => {
    renderApp({ admin: 'multiAdmin' });
    const menu = await nav();
    expect(menu.getByText('Epineon')).toBeInTheDocument();
    expect(menu.getByText('Epi Well')).toBeInTheDocument();
    expect(screen.queryByText('QAegis')).not.toBeInTheDocument();
  });

  test('the overview of a website admin never contains another website\'s data', async () => {
    renderApp({ admin: 'qaegisAdmin' });
    await screen.findByRole('heading', { name: 'Overview' });
    await screen.findByText('Recent submissions');
    expect(await screen.findByText('Quinn Alpha')).toBeInTheDocument();
    for (const other of ['Alice Epineon', 'wendy@epiwell.test', 'Epineon', 'Epi Well']) expect(screen.queryByText(other)).not.toBeInTheDocument();
  });

  test('clicking a link navigates to its page', async () => {
    const { user, location } = renderApp({ admin: 'superAdmin' });
    const menu = await nav();
    await user.click(menu.getByRole('link', { name: 'Sales' }));
    expect(location()).toBe('/apps/epineon/sales');
    expect(await screen.findByRole('heading', { name: 'Epineon · Sales' })).toBeInTheDocument();
  });
});

describe('mobile menu', () => {
  test('opens as a dialog, closes after choosing a page, on Escape, and with the close button', async () => {
    const { user, location } = renderApp({ admin: 'multiAdmin' });
    await screen.findByRole('heading', { name: 'Overview' });

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    let dialog = screen.getByRole('dialog', { name: 'Navigation menu' });
    await user.click(within(dialog).getByRole('link', { name: 'Waitlist' }));
    expect(location()).toBe('/apps/epiwell/waitlist');
    expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    dialog = screen.getByRole('dialog', { name: 'Navigation menu' });
    await user.click(within(dialog).getByRole('button', { name: 'Close menu' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument());
  });

  test('the mobile menu lists only the admin\'s own websites too', async () => {
    const { user } = renderApp({ admin: 'epineonAdmin' });
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const dialog = screen.getByRole('dialog', { name: 'Navigation menu' });
    expect(within(dialog).getByRole('link', { name: 'Demo' })).toBeInTheDocument();
    expect(within(dialog).queryByText('QAegis')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Team management' })).not.toBeInTheDocument();
  });
});
