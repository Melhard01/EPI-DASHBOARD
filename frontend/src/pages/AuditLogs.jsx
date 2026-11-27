import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useSession } from '../auth/SessionContext.js';
import Card from '../components/ui/Card.jsx';
import Pagination from '../components/ui/Pagination.jsx';
import { controlClass } from '../components/ui/controlClass.js';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States.jsx';
import { NeutralBadge } from '../components/ui/Badge.jsx';
import { AUDIT_ACTION_LABELS, actionLabel, formLabel, statusLabel } from '../lib/labels.js';
import { formatDateTime, shortId } from '../lib/format.js';

/** A short, human summary of an entry. Entries never contain submitted personal data. */
function describe(item) {
  if (item.action === 'submission.status_changed') {
    return `${statusLabel(item.details.from)} → ${statusLabel(item.details.to)}`;
  }
  if (item.action === 'submission.deleted') return item.details.status ? `Last status: ${statusLabel(item.details.status)}` : '';
  if (item.action === 'admin_user.created') {
    return item.details.isSuperAdmin ? 'Super Admin' : `Websites: ${(item.details.applications ?? []).join(', ') || 'none'}`;
  }
  if (item.action === 'admin_user.updated') {
    const parts = [];
    if (item.details.status) parts.push(`status: ${item.details.status}`);
    if (item.details.isSuperAdmin !== undefined) parts.push(item.details.isSuperAdmin ? 'made Super Admin' : 'removed Super Admin');
    if (item.details.applicationsAdded?.length) parts.push(`added ${item.details.applicationsAdded.join(', ')}`);
    if (item.details.applicationsRemoved?.length) parts.push(`removed ${item.details.applicationsRemoved.join(', ')}`);
    return parts.join('; ');
  }
  return '';
}

export default function AuditLogs() {
  const { applications } = useSession();
  const [filters, setFilters] = useState({ application: '', action: '', page: 1, pageSize: 50 });
  const set = (changes) => setFilters((previous) => ({ ...previous, page: 1, ...changes }));

  const query = useQuery({
    queryKey: ['audit', filters],
    queryFn: ({ signal }) => api.audit.list({ application: filters.application || undefined, action: filters.action || undefined, page: filters.page, pageSize: filters.pageSize }, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg sm:text-xl md:text-2xl font-semibold" style={{ color: '#000000' }}>Audit logs</h1>
        <p className="mt-1 text-xs sm:text-sm md:text-base" style={{ color: '#000000' }}>Every status change, deletion and change to administrators. Entries never contain submitted personal data.</p>
      </div>

      <Card padded={false}>
        <div className="grid grid-cols-1 gap-3 border-b border-line p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Website
            <select aria-label="Website" className={controlClass} value={filters.application} onChange={(e) => set({ application: e.target.value })}>
              <option value="">All websites</option>
              {applications.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Action
            <select aria-label="Action" className={controlClass} value={filters.action} onChange={(e) => set({ action: e.target.value })}>
              <option value="">All actions</option>
              {Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>

        {query.isPending && <div className="space-y-3 p-5" role="status" aria-label="Loading audit log">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>}
        {query.isError && !query.data && <ErrorState title="Cannot load the audit log" error={query.error} onRetry={() => query.refetch()} />}
        {query.data && query.data.items.length === 0 && <EmptyState icon={ScrollText} title="No entries" description="Nothing matches these filters." />}
        {query.data && query.data.items.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-left text-xs sm:text-sm">
                <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium sm:px-5">When</th>
                    <th scope="col" className="px-3 py-3 font-medium">Who</th>
                    <th scope="col" className="px-3 py-3 font-medium">Action</th>
                    <th scope="col" className="hidden px-3 py-3 font-medium md:table-cell">Target</th>
                    <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell sm:px-5">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {query.data.items.map((item) => (
                    <tr key={item.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-muted sm:px-5">{formatDateTime(item.at)}</td>
                      <td className="max-w-48 truncate px-3 py-3" title={item.actorEmail ?? item.actorId}>{item.actorEmail ?? shortId(item.actorId)}</td>
                      <td className="px-3 py-3 font-medium">{actionLabel(item.action)}</td>
                      <td className="hidden px-3 py-3 md:table-cell">
                        {item.application ? (
                          <span className="flex flex-wrap items-center gap-1">
                            <NeutralBadge>{applications.find((a) => a.slug === item.application)?.name ?? item.application}{item.formType ? ` · ${formLabel(item.formType)}` : ''}</NeutralBadge>
                            {item.submissionId && <span className="text-xs text-muted">{shortId(item.submissionId)}</span>}
                          </span>
                        ) : item.targetUserId ? <span className="text-xs text-muted">admin {shortId(item.targetUserId)}</span> : '—'}
                      </td>
                      <td className="hidden px-4 py-3 text-muted lg:table-cell sm:px-5">{describe(item) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={query.data.pagination.page}
              pageSize={query.data.pagination.pageSize}
              total={query.data.pagination.total}
              totalPages={query.data.pagination.totalPages}
              onPageChange={(page) => setFilters((previous) => ({ ...previous, page }))}
              onPageSizeChange={(pageSize) => set({ pageSize })}
            />
          </>
        )}
      </Card>
    </div>
  );
}
