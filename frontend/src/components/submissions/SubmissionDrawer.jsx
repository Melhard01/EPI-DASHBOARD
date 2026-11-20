import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MailOpen, Trash2 } from 'lucide-react';
import { api } from '../../api/endpoints.js';
import { Drawer, Modal } from '../ui/Overlay.jsx';
import Button from '../ui/Button.jsx';
import { ErrorState, InlineError, Spinner } from '../ui/States.jsx';
import { NeutralBadge, StatusBadge } from '../ui/Badge.jsx';
import { SelectInput } from '../ui/Field.jsx';
import { fieldLabel, formLabel, STATUSES, statusLabel } from '../../lib/labels.js';
import { formatDateTime, shortId } from '../../lib/format.js';

const isHttpUrl = (value) => /^https?:\/\//i.test(value);

function FieldValue({ name, value }) {
  if (name === 'email' || name === 'workEmail') {
    return <a href={`mailto:${value}`} className="break-all text-accent hover:underline">{value}</a>;
  }
  if (name === 'companyWebsite') {
    const href = isHttpUrl(value) ? value : `https://${value}`;
    return <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-accent hover:underline">{value}</a>;
  }
  return <span className="whitespace-pre-wrap break-words">{value}</span>;
}

export default function SubmissionDrawer({ application, formType, id, applicationName, onClose }) {
  const queryClient = useQueryClient();
  const detailKey = ['submission', application, formType, id];
  const [confirmDelete, setConfirmDelete] = useState(false);

  const detail = useQuery({ queryKey: detailKey, queryFn: ({ signal }) => api.submissions.get(application, formType, id, signal), retry: false });

  const refreshLists = () => {
    queryClient.invalidateQueries({ queryKey: ['submissions'] });
    queryClient.invalidateQueries({ queryKey: ['stats'] });
  };

  const update = useMutation({
    mutationFn: (changes) => api.submissions.update(application, formType, id, changes),
    onSuccess: (data) => {
      queryClient.setQueryData(detailKey, data);
      refreshLists();
    },
  });

  const remove = useMutation({
    mutationFn: () => api.submissions.remove(application, formType, id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: detailKey });
      refreshLists();
      setConfirmDelete(false);
      onClose();
    },
  });

  // Opening an unread submission marks it as read (the backend only records it when asked).
  // This looks at the state ONCE, when the submission first loads: if the admin later
  // chooses "Mark as unread", it must stay unread.
  const openedChecked = useRef(false);
  const { mutate: mutateUpdate } = update;
  useEffect(() => {
    if (!detail.data || openedChecked.current) return;
    openedChecked.current = true;
    if (!detail.data.isRead) mutateUpdate({ read: true });
  }, [detail.data, mutateUpdate]);

  const submission = detail.data;
  const email = submission?.data?.email || submission?.data?.workEmail;
  const title = `${applicationName ?? application} · ${formLabel(formType)}`;

  return (
    <>
      <Drawer open title={title} onClose={onClose}>
        {detail.isPending && <Spinner label="Loading submission…" />}
        {detail.isError && <ErrorState title="Cannot load this submission" error={detail.error} onRetry={() => detail.refetch()} />}

        {submission && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={submission.status} />
              <NeutralBadge>{submission.isRead ? 'Read' : 'Unread'}</NeutralBadge>
              <span className="text-xs text-muted">ID {shortId(submission.submissionId)}</span>
            </div>

            <InlineError>{update.error?.message}</InlineError>

            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <SelectInput
                label="Status"
                value={submission.status}
                disabled={update.isPending}
                onChange={(event) => update.mutate({ status: event.target.value })}
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>{statusLabel(status)}</option>
                ))}
              </SelectInput>
              <Button onClick={() => update.mutate({ read: !submission.isRead })} disabled={update.isPending}>
                {submission.isRead ? <Mail className="h-4 w-4" aria-hidden="true" /> : <MailOpen className="h-4 w-4" aria-hidden="true" />}
                {submission.isRead ? 'Mark as unread' : 'Mark as read'}
              </Button>
            </div>

            <dl className="divide-y divide-line rounded-xl border border-line">
              {Object.entries(submission.data).map(([name, value]) => (
                <div key={name} className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
                  <dt className="text-sm text-muted">{fieldLabel(name)}</dt>
                  <dd className="text-sm"><FieldValue name={name} value={value} /></dd>
                </div>
              ))}
            </dl>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted">
              <dt>Received</dt><dd className="text-fg">{formatDateTime(submission.receivedAt)}</dd>
              <dt>Last updated</dt><dd className="text-fg">{formatDateTime(submission.updatedAt)}</dd>
              <dt>First read</dt><dd className="text-fg">{formatDateTime(submission.readAt)}</dd>
              <dt>Status changed</dt><dd className="text-fg">{formatDateTime(submission.statusChangedAt)}</dd>
            </dl>

            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {email && (
                <a href={`mailto:${email}`} className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover">
                  <Mail className="h-4 w-4" aria-hidden="true" /> Reply by email
                </a>
              )}
              <Button variant="danger" onClick={() => setConfirmDelete(true)} className="sm:ml-auto">
                <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete
              </Button>
            </div>
          </div>
        )}
      </Drawer>

      <Modal
        open={confirmDelete}
        title="Delete this submission?"
        onClose={() => !remove.isPending && setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)} disabled={remove.isPending}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete permanently</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>This permanently deletes the submission and the personal data in it. This cannot be undone.</p>
          <p className="text-muted">The deletion is recorded in the audit log without the submitted data.</p>
          <InlineError>{remove.error?.message}</InlineError>
        </div>
      </Modal>
    </>
  );
}
