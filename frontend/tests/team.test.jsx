import { describe, test, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server.js';
import { renderApp } from './utils/render.jsx';
import { BASE, createFakeBackend } from './msw/fakeBackend.js';

const USERS = `${BASE}/api/v1/admin/users`;
const table = async () => within(await screen.findByRole('table'));
const dialog = () => screen.findByRole('dialog');

describe('Team management', () => {
  test('lists administrators with their access, status and last activity', async () => {
    renderApp({ route: '/team' });
    const t = await table();
    expect(await t.findByText('Sam Super')).toBeInTheDocument();
    const superRow = t.getByText('Sam Super').closest('tr');
    expect(within(superRow).getByText('(you)')).toBeInTheDocument();
    expect(within(superRow).getByText('Super Admin')).toBeInTheDocument();
    const epineonRow = t.getByText('epineon@admin.test').closest('tr');
    expect(within(epineonRow).getByText('Epineon')).toBeInTheDocument();
    expect(within(epineonRow).getByText('Active')).toBeInTheDocument();
  });

  test('you cannot disable your own account from the list', async () => {
    renderApp({ route: '/team' });
    const t = await table();
    expect(await t.findByRole('button', { name: 'Disable super@admin.test' })).toBeDisabled();
    expect(t.getByRole('button', { name: 'Disable epineon@admin.test' })).toBeEnabled();
  });

  test('disables and re-enables an administrator', async () => {
    const { user, backend } = renderApp({ route: '/team' });
    const t = await table();
    await user.click(await t.findByRole('button', { name: 'Disable epineon@admin.test' }));
    await waitFor(() => expect(backend.lastWrite('/users').body).toEqual({ status: 'disabled' }));
    expect(await t.findByText('Disabled')).toBeInTheDocument();
    await user.click(t.getByRole('button', { name: 'Enable epineon@admin.test' }));
    await waitFor(() => expect(backend.lastWrite('/users').body).toEqual({ status: 'active' }));
    await waitFor(() => expect(t.queryByText('Disabled')).not.toBeInTheDocument());
  });

  test('shows an empty state when there are no administrators', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers);
    server.use(http.get(USERS, () => HttpResponse.json({ status: 'success', message: 'ok', data: { items: [] } })));
    renderApp({ route: '/team', backend: { ...backend, handlers: [] } });
    expect(await screen.findByText('No administrators')).toBeInTheDocument();
  });

  test('shows an error with retry when the list cannot load', async () => {
    const backend = createFakeBackend();
    server.use(...backend.handlers);
    server.use(http.get(USERS, () => HttpResponse.json({ status: 'error', message: 'Internal Server Error' }, { status: 500 }), { once: true }));
    const { user } = renderApp({ route: '/team', backend: { ...backend, handlers: [] } });
    expect(await screen.findByText('Cannot load administrators')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});

describe('adding an administrator', () => {
  const openForm = async (user) => {
    await user.click(await screen.findByRole('button', { name: 'Add administrator' }));
    return within(await dialog());
  };

  test('creates a website admin with the chosen websites, and the list refreshes', async () => {
    const { user, backend } = renderApp({ route: '/team' });
    const form = await openForm(user);
    await user.type(form.getByLabelText('Email'), 'New.Person@Example.com');
    await user.type(form.getByLabelText('Name (optional)'), 'New Person');
    await user.click(form.getByLabelText('QAegis'));
    await user.click(form.getByLabelText('Epi Well'));
    await user.click(form.getByRole('button', { name: 'Add administrator' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(backend.lastWrite('/users').body).toEqual({ email: 'New.Person@Example.com', displayName: 'New Person', isSuperAdmin: false, applications: ['qaegis', 'epiwell'] });
    expect(await screen.findByText('New Person')).toBeInTheDocument();
  });

  test('a Super Admin needs no website selection: the website boxes are locked and none are sent', async () => {
    const { user, backend } = renderApp({ route: '/team' });
    const form = await openForm(user);
    await user.type(form.getByLabelText('Email'), 'boss@example.com');
    await user.click(form.getByLabelText(/Super Admin/));
    for (const name of ['Epineon', 'QAegis', 'Epi Well']) {
      expect(form.getByLabelText(name)).toBeDisabled();
      expect(form.getByLabelText(name)).toBeChecked();
    }
    await user.click(form.getByRole('button', { name: 'Add administrator' }));
    await waitFor(() => expect(backend.lastWrite('/users').body).toEqual({ email: 'boss@example.com', isSuperAdmin: true, applications: [] }));
  });

  test('the SERVER\'s validation messages appear next to the fields (nothing is re-implemented here)', async () => {
    const { user } = renderApp({ route: '/team' });
    const form = await openForm(user);
    // "not-an-email" passes the browser's loose check once typed as text-like; the server rejects the whole request.
    await user.type(form.getByLabelText('Email'), 'a@b.co');
    await user.click(form.getByRole('button', { name: 'Add administrator' })); // no website and not super admin
    expect(await form.findByText('Grant at least one application or Super Admin')).toBeInTheDocument();
    expect(form.getByRole('button', { name: 'Add administrator' })).toBeEnabled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('a duplicate email shows the server\'s message and keeps the form open', async () => {
    const { user } = renderApp({ route: '/team' });
    const form = await openForm(user);
    await user.type(form.getByLabelText('Email'), 'EPINEON@admin.test');
    await user.click(form.getByLabelText('Epineon'));
    await user.click(form.getByRole('button', { name: 'Add administrator' }));
    expect(await form.findByRole('alert')).toHaveTextContent('An admin with this email already exists');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('cancelling creates nothing', async () => {
    const { user, backend } = renderApp({ route: '/team' });
    const form = await openForm(user);
    await user.type(form.getByLabelText('Email'), 'nobody@example.com');
    await user.click(form.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(backend.requests('/users').filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});

describe('editing an administrator', () => {
  test('changes websites and status, sending the full new state', async () => {
    const { user, backend } = renderApp({ route: '/team' });
    const t = await table();
    await user.click(await t.findByRole('button', { name: 'Edit epineon@admin.test' }));
    const form = within(await dialog());
    expect(form.getByText('epineon@admin.test')).toBeInTheDocument();
    expect(form.getByLabelText('Epineon')).toBeChecked();
    await user.click(form.getByLabelText('QAegis'));
    await user.selectOptions(form.getByLabelText('Account status'), 'disabled');
    await user.click(form.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(backend.lastWrite('/users').body).toEqual({ displayName: null, isSuperAdmin: false, status: 'disabled', applications: ['epineon', 'qaegis'] });
  });

  test('the server refuses removing your own Super Admin access, and the message is shown', async () => {
    const { user } = renderApp({ route: '/team' });
    const t = await table();
    await user.click(await t.findByRole('button', { name: 'Edit super@admin.test' }));
    const form = within(await dialog());
    await user.click(form.getByLabelText(/Super Admin/)); // untick
    await user.click(form.getByRole('button', { name: 'Save changes' }));
    expect(await form.findByRole('alert')).toHaveTextContent('You cannot remove your own Super Admin access or disable yourself');
  });
});
