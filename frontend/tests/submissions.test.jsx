/**
 * Submissions: list, loading / empty / error states, search, filters, sorting,
 * pagination, URL state, per-form pages, the detail drawer, status updates and
 * deletion — all through the real UI against the fake backend.
 */
import { describe, test, expect } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { server } from './msw/server.js';
import { renderApp } from './utils/render.jsx';
import { BASE, createFakeBackend, seedSubmissions } from './msw/fakeBackend.js';

const LIST = `${BASE}/api/v1/admin/submissions`;
const E1 = '11111111-1111-4111-8111-111111111111';
const Q1 = '55555555-5555-4555-8555-555555555555';

const rows = () => screen.getAllByRole('row').slice(1); // without the header row
const rowOf = (name) => screen.getByRole('button', { name: new RegExp(`Open submission from ${name}`) });
const lastList = (backend) => backend.lastRequest('/submissions').query;
const ready = async () => screen.findByRole('table');

function manySubmissions(extra) {
  const base = seedSubmissions();
  const more = Array.from({ length: extra }, (_, i) => ({
    ...base[0],
    submissionId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
    data: { name: `Extra Person ${String(i).padStart(2, '0')}`, email: `extra${i}@epineon.test`, company: 'Bulk', product: 'EPICRYPT' },
    receivedAt: new Date(Date.now() - (10 + i) * 86_400_000).toISOString(),
  }));
  return [...base, ...more];
}

describe('listing', () => {
  test('shows every submission the admin may see, newest first, with unread ones marked', async () => {
    renderApp({ route: '/submissions' });
    await ready();
    const names = rows().map((row) => within(row).getAllByRole('button')[0].getAttribute('aria-label'));
    expect(names.slice(0, 3)).toEqual([
      'Open submission from Alice Epineon',
      'Open submission from Quinn Alpha',
      'Open submission from wendy@epiwell.test',
    ]);
    expect(rows()).toHaveLength(7);
    expect(within(rows()[0]).getByTitle('Unread')).toBeInTheDocument();
    expect(within(rows()[3]).getByTitle('Read')).toBeInTheDocument();
    expect(screen.getByText('1–7 of 7')).toBeInTheDocument();
  });

  test('an admin sees only their own website\'s rows, and no website filter', async () => {
    renderApp({ admin: 'qaegisAdmin', route: '/submissions' });
    await ready();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText('Alice Epineon')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Website')).not.toBeInTheDocument();
  });

  test('shows a loading skeleton while the list loads', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers);
    server.use(http.get(LIST, async () => {
      await delay(150);
      return HttpResponse.json({ status: 'success', message: 'ok', data: { items: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } } });
    }, { once: true }));
    renderApp({ route: '/submissions', backend: { ...backend, handlers: [] } });
    expect(await screen.findByRole('status', { name: 'Loading submissions' })).toBeInTheDocument();
    expect(await screen.findByText('No submissions yet')).toBeInTheDocument();
  });

  test('empty state when there are no submissions at all', async () => {
    renderApp({ route: '/submissions', backend: createFakeBackend({ submissions: [] }) });
    expect(await screen.findByText('No submissions yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  test('a different empty state when filters match nothing, with a way back', async () => {
    const { user } = renderApp({ route: '/submissions' });
    await ready();
    await user.type(screen.getByRole('searchbox', { name: 'Search submissions' }), 'zzz-no-match');
    expect(await screen.findByText('No matching submissions')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(await screen.findAllByRole('row')).toHaveLength(8);
    expect(screen.getByRole('searchbox', { name: 'Search submissions' })).toHaveValue('');
  });

  test('an error shows a message and "Try again" recovers', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers);
    server.use(http.get(LIST, () => HttpResponse.json({ status: 'error', message: 'Internal Server Error' }, { status: 500 }), { once: true }));
    const { user } = renderApp({ route: '/submissions', backend: { ...backend, handlers: [] } });
    expect(await screen.findByText('Cannot load submissions')).toBeInTheDocument();
    expect(screen.getByText('Internal Server Error')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await ready()).toBeInTheDocument();
  });
});

describe('search and filters (all values are sent to the server, which does the filtering)', () => {
  test('search is debounced: one request for the whole word, not one per keystroke', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    await ready();
    await user.type(screen.getByRole('searchbox', { name: 'Search submissions' }), 'quokka');
    await waitFor(() => expect(lastList(backend).q).toBe('quokka'));
    expect(backend.requests('/submissions').filter((r) => r.query.q).map((r) => r.query.q)).toEqual(['quokka']);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByText('Quinn Alpha')).toBeInTheDocument();
  });

  test('filters by status', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    await ready();
    await user.selectOptions(screen.getByLabelText('Status'), 'archived');
    await waitFor(() => expect(lastList(backend).status).toBe('archived'));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByText('Rita Beta')).toBeInTheDocument();
  });

  test('filters by read state', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    await ready();
    await user.selectOptions(screen.getByLabelText('Read state'), 'unread');
    await waitFor(() => expect(lastList(backend).unread).toBe('true'));
    await waitFor(() => expect(rows()).toHaveLength(4));
    await user.selectOptions(screen.getByLabelText('Read state'), 'read');
    await waitFor(() => expect(lastList(backend).unread).toBe('false'));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  test('the "to" date is inclusive: the request asks for everything before the NEXT day', async () => {
    const { backend } = renderApp({ route: '/submissions' });
    await ready();
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-01-05' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-01-10' } });
    await waitFor(() => expect(lastList(backend)).toMatchObject({ from: '2026-01-05', to: '2026-01-11' }));
    expect(await screen.findByText('No matching submissions')).toBeInTheDocument();
  });

  test('sorting by field and direction', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    await ready();
    await user.selectOptions(screen.getByLabelText('Sort by'), 'status');
    await user.selectOptions(screen.getByLabelText('Order'), 'asc');
    await waitFor(() => expect(lastList(backend)).toMatchObject({ sort: 'status', dir: 'asc' }));
  });

  test('"Clear filters" resets everything, including the search box', async () => {
    const { user, location } = renderApp({ route: '/submissions?status=new&read=unread&q=alice' });
    await ready();
    expect(screen.getByRole('searchbox', { name: 'Search submissions' })).toHaveValue('alice');
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(location()).toBe('/submissions');
    expect(screen.getByRole('searchbox', { name: 'Search submissions' })).toHaveValue('');
  });
});

describe('URL state', () => {
  test('filters in the address pre-fill the controls and the request (shareable links)', async () => {
    const { backend } = renderApp({ route: '/submissions?status=new&read=unread&sort=status&dir=asc&pageSize=10' });
    await ready();
    expect(screen.getByLabelText('Status')).toHaveValue('new');
    expect(screen.getByLabelText('Read state')).toHaveValue('unread');
    expect(screen.getByLabelText('Sort by')).toHaveValue('status');
    expect(backend.requests('/submissions').at(-1).query).toMatchObject({ status: 'new', unread: 'true', sort: 'status', dir: 'asc', pageSize: '10' });
  });

  test('changing a filter updates the address', async () => {
    const { user, location } = renderApp({ route: '/submissions' });
    await ready();
    await user.selectOptions(screen.getByLabelText('Status'), 'closed');
    expect(location()).toBe('/submissions?status=closed');
  });

  test('a garbage page number falls back to page 1 instead of breaking', async () => {
    const { backend } = renderApp({ route: '/submissions?page=abc&pageSize=-5' });
    await ready();
    expect(lastList(backend)).toMatchObject({ page: '1', pageSize: '25' });
  });
});

describe('pagination', () => {
  test('pages through the results and changes the page size', async () => {
    const { user, backend } = renderApp({ route: '/submissions?pageSize=10', backend: createFakeBackend({ submissions: manySubmissions(8) }) });
    await ready();
    expect(screen.getByText('1–10 of 15')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastList(backend).page).toBe('2'));
    expect(await screen.findByText('11–15 of 15')).toBeInTheDocument();
    expect(rows()).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('1–10 of 15')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Rows per page'), '25');
    expect(await screen.findByText('1–15 of 15')).toBeInTheDocument();
  });

  test('changing a filter goes back to page 1', async () => {
    const { user, backend } = renderApp({ route: '/submissions?pageSize=10&page=2', backend: createFakeBackend({ submissions: manySubmissions(8) }) });
    await ready();
    expect(lastList(backend).page).toBe('2');
    await user.selectOptions(screen.getByLabelText('Status'), 'new');
    await waitFor(() => expect(lastList(backend)).toMatchObject({ status: 'new', page: '1' }));
  });
});

describe('per-form pages and filters scoped by permission', () => {
  test('a form page requests only that application and form, and has no website/form filter', async () => {
    const { backend } = renderApp({ route: '/apps/epineon/sales' });
    expect(await screen.findByRole('heading', { name: 'Epineon · Sales' })).toBeInTheDocument();
    await ready();
    expect(lastList(backend)).toMatchObject({ application: 'epineon', formType: 'sales' });
    expect(rows()).toHaveLength(1);
    expect(screen.getByText('Carol Sales')).toBeInTheDocument();
    expect(screen.queryByLabelText('Website')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Form')).not.toBeInTheDocument();
  });

  test('the website filter of a two-website admin lists only their websites, and limits the form filter', async () => {
    const { user, backend } = renderApp({ admin: 'multiAdmin', route: '/submissions' });
    await ready();
    const website = screen.getByLabelText('Website');
    expect(within(website).getAllByRole('option').map((o) => o.textContent)).toEqual(['All websites', 'Epineon', 'Epi Well']);
    await user.selectOptions(website, 'epiwell');
    await waitFor(() => expect(lastList(backend).application).toBe('epiwell'));
    expect(within(screen.getByLabelText('Form')).getAllByRole('option').map((o) => o.textContent)).toEqual(['All forms', 'Waitlist']);
  });

  test('a Super Admin can narrow to a website and then one of its forms', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    await ready();
    await user.selectOptions(screen.getByLabelText('Website'), 'epineon');
    await user.selectOptions(screen.getByLabelText('Form'), 'partnerships');
    await waitFor(() => expect(lastList(backend)).toMatchObject({ application: 'epineon', formType: 'partnerships' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByText('Dan Partner')).toBeInTheDocument();
  });
});

describe('detail drawer', () => {
  test('opens a submission with its fields, labelled in plain language', async () => {
    const { user, location } = renderApp({ route: '/submissions' });
    await ready();
    await user.click(rowOf('Alice Epineon'));
    const drawer = await screen.findByRole('dialog', { name: 'Epineon · Demo' });
    expect(new URLSearchParams(location().split('?')[1]).get('open')).toBe(`epineon/demo/${E1}`);
    expect(location()).not.toContain('page=');
    expect(within(drawer).getByText('Product of interest')).toBeInTheDocument();
    expect(within(drawer).getByText('EPICRYPT')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'alice@epineon.test' })).toHaveAttribute('href', 'mailto:alice@epineon.test');
    expect(within(drawer).getByRole('link', { name: 'Reply by email' })).toHaveAttribute('href', 'mailto:alice@epineon.test');
  });

  test('opening an unread submission marks it read (once) and updates the list', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    await ready();
    expect(within(rowOf('Alice Epineon').closest('tr')).getByTitle('Unread')).toBeInTheDocument();
    await user.click(rowOf('Alice Epineon'));
    await screen.findByRole('dialog', { name: 'Epineon · Demo' });
    await waitFor(() => expect(backend.requests('/submissions/epineon/demo').filter((r) => r.method === 'PATCH')).toHaveLength(1));
    expect(backend.lastRequest('/submissions/epineon/demo').body).toEqual({ read: true });
    await waitFor(() => expect(within(rowOf('Alice Epineon').closest('tr')).getByTitle('Read')).toBeInTheDocument());
    expect(screen.getByText('Read', { selector: 'span' })).toBeInTheDocument();
  });

  test('opening an already-read submission changes nothing', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    await ready();
    await user.click(rowOf('Bob Demo'));
    const drawer = await screen.findByRole('dialog', { name: 'Epineon · Demo' });
    await within(drawer).findByText('Globex');
    expect(backend.requests('/submissions/epineon/demo').filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  test('changes the status and sends exactly that change', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    await ready();
    await user.click(rowOf('Bob Demo'));
    const drawer = await screen.findByRole('dialog', { name: 'Epineon · Demo' });
    await user.selectOptions(within(drawer).getByLabelText('Status'), 'closed');
    await waitFor(() => expect(backend.lastRequest('/submissions/epineon/demo').body).toEqual({ status: 'closed' }));
    await waitFor(() => expect(within(rowOf('Bob Demo').closest('tr')).getByText('Closed')).toBeInTheDocument());
    expect(backend.state.submissions.find((s) => s.submissionId === '22222222-2222-4222-8222-222222222222').status).toBe('closed');
  });

  test('can mark a submission as unread again', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    await ready();
    await user.click(rowOf('Bob Demo'));
    const drawer = await screen.findByRole('dialog', { name: 'Epineon · Demo' });
    await user.click(within(drawer).getByRole('button', { name: 'Mark as unread' }));
    await waitFor(() => expect(backend.lastRequest('/submissions/epineon/demo').body).toEqual({ read: false }));
    expect(await within(drawer).findByRole('button', { name: 'Mark as read' })).toBeInTheDocument();
    // ...and it STAYS unread: opening must not mark it read again.
    await new Promise((r) => setTimeout(r, 100));
    expect(backend.requests('/submissions/epineon/demo').filter((r) => r.method === 'PATCH')).toHaveLength(1);
    expect(backend.state.submissions.find((s) => s.submissionId === '22222222-2222-4222-8222-222222222222').isRead).toBe(false);
  });

  test('shows the server\'s message when an update is refused, and keeps the drawer open', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers);
    server.use(http.patch(`${LIST}/:a/:f/:id`, () => HttpResponse.json({ status: 'error', message: 'Validation failed' }, { status: 400 })));
    const { user } = renderApp({ route: '/submissions', backend: { ...backend, handlers: [] } });
    await ready();
    await user.click(rowOf('Bob Demo'));
    const drawer = await screen.findByRole('dialog', { name: 'Epineon · Demo' });
    await user.selectOptions(within(drawer).getByLabelText('Status'), 'archived');
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('Validation failed');
  });

  test('keeps multi-line messages and never turns a dangerous website value into a script link', async () => {
    const submissions = seedSubmissions();
    submissions.find((s) => s.submissionId === Q1).data.companyWebsite = 'javascript:alert(document.cookie)';
    const { user } = renderApp({ route: '/submissions', backend: createFakeBackend({ submissions }) });
    await ready();
    await user.click(rowOf('Carol Sales'));
    let drawer = await screen.findByRole('dialog', { name: 'Epineon · Sales' });
    const message = within(drawer).getByText(/Zanzibar rollout/);
    expect(message.textContent).toBe('Zanzibar rollout\nsecond line');
    expect(message).toHaveClass('whitespace-pre-wrap');
    await user.keyboard('{Escape}');

    await user.click(rowOf('Quinn Alpha'));
    drawer = await screen.findByRole('dialog', { name: 'QAegis · Contact Sales' });
    for (const link of within(drawer).queryAllByRole('link')) expect(link.getAttribute('href')).not.toMatch(/^javascript:/i);
    const site = within(drawer).getByText(/javascript:alert/);
    expect(site.closest('a').getAttribute('href')).toBe('https://javascript:alert(document.cookie)');
    expect(site.closest('a')).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('a website value without a scheme becomes an https link', async () => {
    const { user } = renderApp({ route: '/submissions' });
    await ready();
    await user.click(rowOf('Quinn Alpha'));
    const drawer = await screen.findByRole('dialog', { name: 'QAegis · Contact Sales' });
    expect(within(drawer).getByRole('link', { name: 'example.com' })).toHaveAttribute('href', 'https://example.com');
  });

  test('a submission of another website opened by URL is refused by the server and the drawer says so', async () => {
    renderApp({ admin: 'epineonAdmin', route: `/submissions?open=qaegis/contact-sales/${Q1}` });
    expect(await screen.findByText('Cannot load this submission')).toBeInTheDocument();
    expect(screen.getByText('You do not have access to this application')).toBeInTheDocument();
    expect(screen.queryByText('Quinn Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('quinn@qaegis.test')).not.toBeInTheDocument();
  });

  test('a submission that does not exist shows "not found"', async () => {
    renderApp({ route: '/submissions?open=epineon/demo/99999999-9999-4999-8999-999999999999' });
    expect(await screen.findByText('Submission not found')).toBeInTheDocument();
  });

  test('closing the drawer removes it from the address', async () => {
    const { user, location } = renderApp({ route: '/submissions' });
    await ready();
    await user.click(rowOf('Bob Demo'));
    await screen.findByRole('dialog', { name: 'Epineon · Demo' });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Epineon · Demo' })).not.toBeInTheDocument();
    expect(location()).not.toContain('open=');
  });
});

describe('deleting', () => {
  const openAndAskDelete = async (user, name) => {
    await ready();
    await user.click(rowOf(name));
    const drawer = await screen.findByRole('dialog', { name: /·/ });
    await user.click(within(drawer).getByRole('button', { name: 'Delete' }));
    return screen.findByRole('dialog', { name: 'Delete this submission?' });
  };

  test('asks for confirmation, and cancelling deletes nothing', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    const confirm = await openAndAskDelete(user, 'Bob Demo');
    expect(within(confirm).getByText(/permanently deletes/i)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Delete this submission?' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Epineon · Demo' })).toBeInTheDocument();
    expect(backend.requests('/submissions').filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  test('confirming deletes it, closes everything, and the row disappears', async () => {
    const { user, backend } = renderApp({ route: '/submissions' });
    const confirm = await openAndAskDelete(user, 'Bob Demo');
    await user.click(within(confirm).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(backend.requests('/submissions').filter((r) => r.method === 'DELETE')).toHaveLength(1);
    expect(backend.lastRequest('/submissions/epineon/demo').path).toBe('/submissions/epineon/demo/22222222-2222-4222-8222-222222222222');
    await waitFor(() => expect(screen.queryByText('Bob Demo')).not.toBeInTheDocument());
    expect(rows()).toHaveLength(6);
  });

  test('a failed delete shows the server message and keeps the submission', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers);
    server.use(http.delete(`${LIST}/:a/:f/:id`, () => HttpResponse.json({ status: 'error', message: 'You do not have access to this application' }, { status: 403 })));
    const { user } = renderApp({ route: '/submissions', backend: { ...backend, handlers: [] } });
    const confirm = await openAndAskDelete(user, 'Bob Demo');
    await user.click(within(confirm).getByRole('button', { name: 'Delete permanently' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent('You do not have access to this application');
    expect(backend.state.submissions.some((s) => s.submissionId === '22222222-2222-4222-8222-222222222222')).toBe(true);
  });

  test('Escape closes only the confirmation, not the drawer underneath', async () => {
    const { user } = renderApp({ route: '/submissions' });
    await openAndAskDelete(user, 'Bob Demo');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Delete this submission?' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Epineon · Demo' })).toBeInTheDocument();
  });
});
