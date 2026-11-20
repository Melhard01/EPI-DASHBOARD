import { describe, test, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server.js';
import { renderApp } from './utils/render.jsx';
import { BASE, createFakeBackend } from './msw/fakeBackend.js';

vi.mock('../src/config.js', () => ({ config: { apiBaseUrl: '', accessLogoutUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/logout' } }));

const AUDIT = `${BASE}/api/v1/admin/audit`;

describe('Audit logs', () => {
  test('lists entries with readable actions, who did it, and what changed', async () => {
    renderApp({ route: '/audit' });
    const table = within(await screen.findByRole('table'));
    expect(await table.findByText('Status changed')).toBeInTheDocument();
    expect(table.getByText('Replied', { exact: false })).toBeInTheDocument();
    expect(table.getByText('New → Replied')).toBeInTheDocument();
    expect(table.getByText('Admin created')).toBeInTheDocument();
    expect(table.getByText('Websites: epineon')).toBeInTheDocument();
    expect(table.getByText('Submission deleted')).toBeInTheDocument();
    expect(table.getByText('Last status: Closed')).toBeInTheDocument();
    expect(table.getAllByText('super@admin.test').length).toBeGreaterThan(0);
    expect(table.getByText(/Epineon · Demo/)).toBeInTheDocument();
  });

  test('never shows submitted personal data (the API does not send any)', async () => {
    const { container } = renderApp({ route: '/audit' });
    await screen.findByText('Status changed');
    for (const personal of ['alice@epineon.test', 'Alice', 'Zanzibar']) expect(container.textContent).not.toContain(personal);
  });

  test('filters by website and by action on the server', async () => {
    const { user, backend } = renderApp({ route: '/audit' });
    await screen.findByText('Status changed');
    await user.selectOptions(screen.getByLabelText('Action'), 'submission.deleted');
    await waitFor(() => expect(backend.lastRequest('/audit').query.action).toBe('submission.deleted'));
    await waitFor(() => expect(within(screen.getByRole('table')).queryByText('Admin created')).not.toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Website'), 'qaegis');
    expect(await screen.findByText('Nothing matches these filters.')).toBeInTheDocument();
    expect(backend.lastRequest('/audit').query).toMatchObject({ application: 'qaegis', action: 'submission.deleted' });
  });

  test('shows an error with retry', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers);
    server.use(http.get(AUDIT, () => HttpResponse.json({ status: 'error', message: 'Internal Server Error' }, { status: 500 }), { once: true }));
    const { user } = renderApp({ route: '/audit', backend: { ...backend, handlers: [] } });
    expect(await screen.findByText('Cannot load the audit log')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await within(await screen.findByRole('table')).findByText('Status changed')).toBeInTheDocument();
  });
});

describe('Settings', () => {
  test('shows the account, role and exactly the websites the admin can use', async () => {
    renderApp({ admin: 'multiAdmin', route: '/settings' });
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getAllByText('multi@admin.test').length).toBeGreaterThan(0);
    const access = within(screen.getByRole('heading', { name: 'What you can access' }).closest('section'));
    expect(access.getByText('Epineon')).toBeInTheDocument();
    expect(access.getByText('Epi Well')).toBeInTheDocument();
    expect(access.queryByText('QAegis')).not.toBeInTheDocument();
    expect(screen.getAllByText('Website admin').length).toBeGreaterThan(0);
  });

  test('a Super Admin sees their role and every website', async () => {
    renderApp({ route: '/settings' });
    const access = within((await screen.findByRole('heading', { name: 'What you can access' })).closest('section'));
    for (const name of ['Epineon', 'QAegis', 'Epi Well']) expect(access.getByText(name)).toBeInTheDocument();
    expect(screen.getByText(/manage administrators/i)).toBeInTheDocument();
  });

  test('theme choice applies immediately and is remembered', async () => {
    const { user } = renderApp({ route: '/settings' });
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.getByRole('radio', { name: 'Match my device' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('admin:theme')).toBe('dark');
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  test('offers the Cloudflare Access sign-out link when configured, and explains that no password is stored here', async () => {
    renderApp({ route: '/settings' });
    expect(await screen.findByRole('link', { name: /Sign out/ })).toHaveAttribute('href', 'https://team.cloudflareaccess.com/cdn-cgi/access/logout');
    expect(screen.getByText(/Passwords are never stored by this dashboard/)).toBeInTheDocument();
  });
});
