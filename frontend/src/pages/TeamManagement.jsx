import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserCog } from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useSession } from '../auth/SessionContext.js';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import { Modal } from '../components/ui/Overlay.jsx';
import { Checkbox, SelectInput, TextInput } from '../components/ui/Field.jsx';
import { EmptyState, ErrorState, InlineError, Skeleton } from '../components/ui/States.jsx';
import { Badge, NeutralBadge } from '../components/ui/Badge.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * Create / edit form. It sends what the user entered and shows what the SERVER
 * says is wrong (field errors and rule violations such as "cannot disable
 * yourself"); it does not re-implement the backend's rules.
 */
function UserFormModal({ user, applications, onClose }) {
  const queryClient = useQueryClient();
  const isNew = !user;
  const [form, setForm] = useState({
    email: user?.email ?? '',
    displayName: user?.displayName ?? '',
    isSuperAdmin: user?.isSuperAdmin ?? false,
    status: user?.status ?? 'active',
    applications: user?.applications ?? [],
  });
  const set = (changes) => setForm((previous) => ({ ...previous, ...changes }));

  const save = useMutation({
    mutationFn: () => {
      const displayName = form.displayName.trim();
      if (isNew) {
        return api.users.create({
          email: form.email.trim(),
          ...(displayName ? { displayName } : {}),
          isSuperAdmin: form.isSuperAdmin,
          applications: form.isSuperAdmin ? [] : form.applications,
        });
      }
      return api.users.update(user.id, {
        displayName: displayName || null,
        isSuperAdmin: form.isSuperAdmin,
        status: form.status,
        applications: form.applications,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  const fieldErrors = save.error?.fieldErrors ?? {};
  const generalError = save.error && Object.keys(fieldErrors).length === 0 ? save.error.message : null;

  const toggleApplication = (slug, checked) =>
    set({ applications: checked ? [...form.applications, slug] : form.applications.filter((s) => s !== slug) });

  return (
    <Modal
      open
      title={isNew ? 'Add administrator' : 'Edit administrator'}
      onClose={() => !save.isPending && onClose()}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>{isNew ? 'Add administrator' : 'Save changes'}</Button>
        </>
      }
    >
      <form
        id="user-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        {/* Lets the Enter key submit the form (the visible button lives in the dialog footer). */}
        <button type="submit" tabIndex={-1} aria-hidden="true" className="sr-only">Submit</button>
        <InlineError>{generalError}</InlineError>
        {isNew ? (
          <TextInput label="Email" type="email" required autoComplete="off" value={form.email} onChange={(e) => set({ email: e.target.value })} error={fieldErrors.email} hint="Must be the email they sign in with through Cloudflare Access." />
        ) : (
          <p className="text-sm"><span className="text-muted">Email: </span>{user.email}</p>
        )}
        <TextInput label="Name (optional)" value={form.displayName} maxLength={120} onChange={(e) => set({ displayName: e.target.value })} error={fieldErrors.displayName} />

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Access</legend>
          <Checkbox
            label="Super Admin"
            description="Full access to every website, administrators and the audit log."
            checked={form.isSuperAdmin}
            onChange={(e) => set({ isSuperAdmin: e.target.checked })}
          />
          {fieldErrors.isSuperAdmin && <p role="alert" className="text-xs text-danger">{fieldErrors.isSuperAdmin}</p>}
          <div className="space-y-2 rounded-lg border border-line p-3">
            <p className="text-xs text-muted">{form.isSuperAdmin ? 'Super Admins can use every website.' : 'Websites this person can manage:'}</p>
            {applications.map((application) => (
              <Checkbox
                key={application.slug}
                label={application.name}
                checked={form.isSuperAdmin || form.applications.includes(application.slug)}
                disabled={form.isSuperAdmin}
                onChange={(e) => toggleApplication(application.slug, e.target.checked)}
              />
            ))}
          </div>
          {fieldErrors.applications && <p role="alert" className="text-xs text-danger">{fieldErrors.applications}</p>}
        </fieldset>

        {!isNew && (
          <SelectInput label="Account status" value={form.status} onChange={(e) => set({ status: e.target.value })} error={fieldErrors.status}>
            <option value="active">Active</option>
            <option value="disabled">Disabled (cannot sign in to the dashboard)</option>
          </SelectInput>
        )}
      </form>
    </Modal>
  );
}

function AccessBadges({ user, applicationName }) {
  if (user.isSuperAdmin) return <Badge className="bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300">Super Admin</Badge>;
  if (user.applications.length === 0) return <span className="text-xs text-muted">No websites</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {user.applications.map((slug) => <NeutralBadge key={slug}>{applicationName(slug)}</NeutralBadge>)}
    </span>
  );
}

export default function TeamManagement() {
  const { admin: me, applications } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(null); // null | 'new' | a user
  const users = useQuery({ queryKey: ['users'], queryFn: ({ signal }) => api.users.list(signal), retry: false });

  const toggleStatus = useMutation({
    mutationFn: ({ id, status }) => api.users.update(id, { status }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const applicationName = (slug) => applications.find((a) => a.slug === slug)?.name ?? slug;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: '#000000' }}>Team management</h1>
          <p className="mt-1 text-sm text-muted">Who can sign in, and which websites each person can manage.</p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" aria-hidden="true" /> Add administrator
        </Button>
      </div>

      <InlineError>{toggleStatus.error?.message}</InlineError>

      <Card padded={false}>
        {users.isPending && <div className="space-y-3 p-5" role="status" aria-label="Loading administrators">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>}
        {users.isError && <ErrorState title="Cannot load administrators" error={users.error} onRetry={() => users.refetch()} />}
        {users.data && users.data.items.length === 0 && <EmptyState icon={UserCog} title="No administrators" description="Add the first administrator to get started." />}
        {users.data && users.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[22rem] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium sm:px-5">Administrator</th>
                  <th scope="col" className="px-3 py-3 font-medium">Access</th>
                  <th scope="col" className="hidden px-3 py-3 font-medium md:table-cell">Last active</th>
                  <th scope="col" className="px-3 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium sm:px-5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.data.items.map((user) => {
                  const isMe = user.id === me.id;
                  const disabled = user.status === 'disabled';
                  return (
                    <tr key={user.id}>
                      <td className="px-4 py-3 sm:px-5">
                        <p className="font-medium">{user.displayName || user.email}{isMe && <span className="ml-2 text-xs font-normal text-muted">(you)</span>}</p>
                        {user.displayName && <p className="text-xs text-muted">{user.email}</p>}
                      </td>
                      <td className="px-3 py-3"><AccessBadges user={user} applicationName={applicationName} /></td>
                      <td className="hidden px-3 py-3 text-muted md:table-cell">{user.lastSeenAt ? timeAgo(user.lastSeenAt) : 'Never'}</td>
                      <td className="px-3 py-3">
                        <Badge className={disabled ? 'bg-zinc-200 text-zinc-600 dark:bg-zinc-500/20 dark:text-zinc-400' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'}>
                          {disabled ? 'Disabled' : 'Active'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 sm:px-5">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" onClick={() => setEditing(user)} aria-label={`Edit ${user.email}`}>Edit</Button>
                          <Button
                            size="sm"
                            disabled={isMe || toggleStatus.isPending}
                            title={isMe ? 'You cannot disable your own account' : undefined}
                            onClick={() => toggleStatus.mutate({ id: user.id, status: disabled ? 'active' : 'disabled' })}
                            aria-label={`${disabled ? 'Enable' : 'Disable'} ${user.email}`}
                          >
                            {disabled ? 'Enable' : 'Disable'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && <UserFormModal user={editing === 'new' ? null : editing} applications={applications} onClose={() => setEditing(null)} />}
    </div>
  );
}
