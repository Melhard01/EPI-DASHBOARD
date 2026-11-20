import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { api } from '../../api/endpoints.js';
import { useSession } from '../../auth/SessionContext.js';
import Card from '../ui/Card.jsx';
import Pagination from '../ui/Pagination.jsx';
import Button from '../ui/Button.jsx';
import { EmptyState, ErrorState, Skeleton } from '../ui/States.jsx';
import SubmissionFilters from './SubmissionFilters.jsx';
import SubmissionsTable from './SubmissionsTable.jsx';
import SubmissionDrawer from './SubmissionDrawer.jsx';
import { nextDay } from '../../lib/format.js';

const SEARCH_DEBOUNCE_MS = 350;
const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** URL query string → filter state. Everything is optional; the server validates. */
function readState(params, fixedApplication, fixedFormType) {
  const get = (key, fallback = '') => params.get(key) ?? fallback;
  return {
    q: get('q'),
    status: get('status'),
    read: get('read'),
    from: get('from'),
    to: get('to'),
    sort: get('sort', 'receivedAt'),
    dir: get('dir', 'desc'),
    page: positiveInt(get('page'), 1),
    pageSize: positiveInt(get('pageSize'), 25),
    application: fixedApplication ?? get('application'),
    formType: fixedFormType ?? get('formType'),
  };
}

function toApiParams(state) {
  return {
    application: state.application || undefined,
    formType: state.formType || undefined,
    status: state.status || undefined,
    unread: state.read === 'unread' ? true : state.read === 'read' ? false : undefined,
    from: state.from || undefined,
    // The API's `to` is exclusive, the date picker's is inclusive.
    to: state.to ? nextDay(state.to) : undefined,
    q: state.q || undefined,
    sort: state.sort,
    dir: state.dir,
    page: state.page,
    pageSize: state.pageSize,
  };
}

/**
 * The submissions list used by "All submissions" and by every per-form page.
 * Filters, sorting, paging and the open submission are kept in the URL.
 */
export default function SubmissionsView({ title, description, fixedApplication, fixedFormType }) {
  const { applications } = useSession();
  const [params, setParams] = useSearchParams();
  const state = readState(params, fixedApplication, fixedFormType);
  const [search, setSearch] = useState(state.q);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const update = (changes) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value === '' || value === undefined || value === null) next.delete(key);
          else next.set(key, String(value));
        }
        if (!('page' in changes)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  };

  const onSearch = (value) => {
    setSearch(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => update({ q: value.trim() }), SEARCH_DEBOUNCE_MS);
  };

  const apiParams = toApiParams(state);
  const query = useQuery({
    queryKey: ['submissions', apiParams],
    queryFn: ({ signal }) => api.submissions.list(apiParams, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const applicationName = (slug) => applications.find((a) => a.slug === slug)?.name ?? slug;

  const hasFilters = Boolean(state.q || state.status || state.read || state.from || state.to || (!fixedApplication && state.application) || (!fixedFormType && state.formType));
  const clearFilters = () => {
    clearTimeout(timer.current);
    setSearch('');
    setParams(new URLSearchParams(), { replace: true });
  };

  // The open submission is "application/formType/id" in the URL.
  const open = params.get('open')?.split('/') ?? [];
  const opened = open.length === 3 ? { application: open[0], formType: open[1], id: open[2] } : null;
  // Opening / closing a submission keeps the list exactly as it is (same page, same filters).
  const samePage = params.get('page') ?? '';
  const openItem = (item) => update({ open: `${item.application}/${item.formType}/${item.submissionId}`, page: samePage });
  const closeItem = () => update({ open: '', page: samePage });

  const data = query.data;
  const firstLoad = query.isPending;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>

      <Card padded={false} aria-busy={query.isFetching || undefined}>
        <SubmissionFilters
          state={state}
          search={search}
          onSearch={onSearch}
          onChange={update}
          onClear={clearFilters}
          applications={applications}
          showApplication={!fixedApplication && applications.length > 1}
          showFormType={!fixedFormType}
          hasFilters={hasFilters}
        />

        {firstLoad && (
          <div className="space-y-3 p-5" role="status" aria-label="Loading submissions">
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12" />)}
          </div>
        )}

        {query.isError && !data && (
          <ErrorState title="Cannot load submissions" error={query.error} onRetry={() => query.refetch()} />
        )}

        {data && data.items.length === 0 && (
          <EmptyState
            icon={Inbox}
            title={hasFilters ? 'No matching submissions' : 'No submissions yet'}
            description={hasFilters ? 'Try changing or clearing the filters.' : 'New submissions will appear here as soon as they arrive.'}
            action={hasFilters ? <Button size="sm" onClick={clearFilters}>Clear filters</Button> : null}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <SubmissionsTable items={data.items} showForm={!fixedFormType} applicationName={applicationName} onOpen={openItem} />
            <Pagination
              page={data.pagination.page}
              pageSize={data.pagination.pageSize}
              total={data.pagination.total}
              totalPages={data.pagination.totalPages}
              onPageChange={(page) => update({ page })}
              onPageSizeChange={(pageSize) => update({ pageSize })}
            />
          </>
        )}
      </Card>

      {opened && (
        <SubmissionDrawer
          key={`${opened.application}/${opened.formType}/${opened.id}`}
          {...opened}
          applicationName={applicationName(opened.application)}
          onClose={closeItem}
        />
      )}
    </div>
  );
}
