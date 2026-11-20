import { describe, test, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { server } from './msw/server.js';
import { renderApp } from './utils/render.jsx';
import { BASE, createFakeBackend } from './msw/fakeBackend.js';

const STATS = `${BASE}/api/v1/admin/stats`;
const stat = (label) => screen.getByText(label, { selector: 'p' }).parentElement;

describe('Overview', () => {
  test('a Super Admin sees combined statistics, charts, per-website cards and recent submissions', async () => {
    renderApp();
    await screen.findByText('Submissions per day');
    expect(within(stat('Submissions')).getByText('7')).toBeInTheDocument();
    expect(within(stat('Unread')).getByText('4')).toBeInTheDocument();
    expect(within(stat('Websites')).getByText('3')).toBeInTheDocument();
    expect(within(stat('Websites')).getByText('Epineon, QAegis, Epi Well')).toBeInTheDocument();

    // charts are exposed to assistive technology with a text summary
    expect(await screen.findByRole('img', { name: /Submissions per day over the last 30 days: \d+ in total/ })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /Submissions per website: Epineon: 4, QAegis: 2, Epi Well: 1/ })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'New share' })).toBeInTheDocument();

    const sites = within(screen.getByRole('region', { name: 'Websites' }));
    for (const name of ['Epineon', 'QAegis', 'Epi Well']) expect(sites.getByRole('heading', { name })).toBeInTheDocument();
    expect(sites.getByRole('link', { name: /^Sales/ })).toHaveAttribute('href', '/apps/epineon/sales');
    expect(sites.getByRole('link', { name: /Waitlist/ })).toHaveAttribute('href', '/apps/epiwell/waitlist');

    expect(await screen.findByText('Quinn Alpha')).toBeInTheDocument();
  });

  test('a website admin sees only their own website — numbers, charts, cards and recent items', async () => {
    renderApp({ admin: 'epineonAdmin' });
    await screen.findByText('Submissions per day');
    expect(within(stat('Submissions')).getByText('4')).toBeInTheDocument();
    expect(within(stat('Website')).getByText('1')).toBeInTheDocument();
    const sites = within(screen.getByRole('region', { name: 'Websites' }));
    expect(sites.getByRole('heading', { name: 'Epineon' })).toBeInTheDocument();
    expect(sites.queryByRole('heading', { name: 'QAegis' })).not.toBeInTheDocument();
    expect(screen.queryByText('By website')).not.toBeInTheDocument();
    expect(await screen.findByText('Alice Epineon')).toBeInTheDocument();
    for (const other of ['Quinn Alpha', 'wendy@epiwell.test', 'QAegis', 'Epi Well']) expect(screen.queryByText(other)).not.toBeInTheDocument();
  });

  test('the unread card links to the unread list, and recent submissions open the drawer', async () => {
    const { user, location } = renderApp();
    await screen.findByText('Submissions per day');
    expect(stat('Unread').closest('a')).toHaveAttribute('href', '/submissions?read=unread');
    await user.click(await screen.findByText('Alice Epineon'));
    expect(new URLSearchParams(location().split('?')[1]).get('open')).toMatch(/^epineon\/demo\/11111111/);
    expect(await screen.findByRole('dialog', { name: 'Epineon · Demo' })).toBeInTheDocument();
  });

  test('changing the period asks the server for that many days', async () => {
    const { user, backend } = renderApp();
    await screen.findByText('Submissions per day');
    await user.selectOptions(screen.getByLabelText('Period'), '90');
    await waitFor(() => expect(backend.lastRequest('/stats').query).toEqual({ days: '90' }));
    expect(await screen.findByText('Last 90 days', { selector: 'p' })).toBeInTheDocument();
  });

  test('shows loading placeholders while statistics load', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers);
    server.use(http.get(STATS, async () => {
      await delay(150);
      return HttpResponse.json({ status: 'success', message: 'ok', data: { days: 30, applications: {}, combined: { total: 0, unread: 0, receivedInPeriod: 0, byStatus: {}, byApplication: {}, daily: [] } } });
    }, { once: true }));
    renderApp({ backend: { ...backend, handlers: [] } });
    expect(await screen.findByRole('status', { name: 'Loading statistics' })).toBeInTheDocument();
  });

  test('an empty database shows a friendly empty state instead of zeros and blank charts', async () => {
    renderApp({ backend: createFakeBackend({ submissions: [] }) });
    expect(await screen.findByText('No submissions yet')).toBeInTheDocument();
    expect(screen.queryByText('Submissions per day')).not.toBeInTheDocument();
  });

  test('an error shows a message with a working retry', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers);
    server.use(http.get(STATS, () => HttpResponse.json({ status: 'error', message: 'Internal Server Error' }, { status: 500 }), { once: true }));
    const { user } = renderApp({ backend: { ...backend, handlers: [] } });
    expect(await screen.findByText('Cannot load statistics')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Submissions per day')).toBeInTheDocument();
  });
});
