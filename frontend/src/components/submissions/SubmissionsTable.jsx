import { NeutralBadge, StatusBadge } from '../ui/Badge.jsx';
import { contactOf, formLabel, summaryOf } from '../../lib/labels.js';
import { formatDateTime, timeAgo } from '../../lib/format.js';

/**
 * Responsive table: on small screens only the contact and status columns stay;
 * the rest appear as the viewport grows. The contact cell is a real button, so
 * rows are keyboard accessible.
 */
export default function SubmissionsTable({ items, showForm, applicationName, onOpen }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[20rem] text-left text-sm">
        <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium sm:px-5">Contact</th>
            {showForm && <th scope="col" className="hidden px-3 py-3 font-medium sm:table-cell">Form</th>}
            <th scope="col" className="hidden px-3 py-3 font-medium md:table-cell">Details</th>
            <th scope="col" className="hidden px-3 py-3 font-medium sm:table-cell">Received</th>
            <th scope="col" className="px-4 py-3 font-medium sm:px-5">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((item) => {
            const contact = contactOf(item.data);
            const summary = summaryOf(item.data);
            return (
              <tr key={`${item.application}/${item.formType}/${item.submissionId}`} className="hover:bg-surface-2">
                <td className="px-4 py-3 sm:px-5">
                  <button
                    type="button"
                    onClick={() => onOpen(item)}
                    aria-label={`Open submission from ${contact.title}`}
                    className="group flex w-full items-start gap-3 text-left"
                  >
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.isRead ? 'bg-transparent' : 'bg-accent'}`}
                      title={item.isRead ? 'Read' : 'Unread'}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className={`block truncate ${item.isRead ? 'font-medium' : 'font-semibold'}`}>{contact.title}</span>
                      {contact.name && contact.email && <span className="block truncate text-xs text-muted">{contact.email}</span>}
                      {summary && <span className="block truncate text-xs text-muted md:hidden">{summary}</span>}
                      <span className="block text-xs text-muted sm:hidden">{timeAgo(item.receivedAt)}</span>
                    </span>
                  </button>
                </td>
                {showForm && (
                  <td className="hidden px-3 py-3 sm:table-cell">
                    <NeutralBadge>{applicationName(item.application)} · {formLabel(item.formType)}</NeutralBadge>
                  </td>
                )}
                <td className="hidden max-w-xs truncate px-3 py-3 text-muted md:table-cell">{summary || '—'}</td>
                <td className="hidden whitespace-nowrap px-3 py-3 text-muted sm:table-cell" title={formatDateTime(item.receivedAt)}>
                  {timeAgo(item.receivedAt)}
                </td>
                <td className="px-4 py-3 sm:px-5"><StatusBadge status={item.status} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
