import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useSession } from '../auth/SessionContext.js';
import Card from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States.jsx';
import { NeutralBadge, StatusBadge } from '../components/ui/Badge.jsx';
import { StatusBars } from '../components/charts/StatusBars.jsx';

// The charting library is only downloaded when the Overview page needs it.
const DailyChart = lazy(() => import('../components/charts/DailyChart.jsx'));
const WebsiteChart = lazy(() => import('../components/charts/WebsiteChart.jsx'));
const chartFallback = <Skeleton className="h-64" />;
import { contactOf, formLabel } from '../lib/labels.js';
import { timeAgo } from '../lib/format.js';

const RANGES = [7, 30, 90];

function StatCard({ label, value, hint, to }) {
  const body = (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
  return to ? <Link to={to} className="block rounded-xl transition-shadow hover:shadow-md">{body}</Link> : body;
}

function ApplicationCard({ slug, name, stats }) {
  const { application } = useSession();
  const forms = application(slug)?.formTypes ?? Object.keys(stats.byFormType);
  return (
    <Card title={name} padded={false}>
      <dl className="grid grid-cols-3 divide-x divide-line border-b border-line text-center">
        {[['Total', stats.total], ['Unread', stats.unread], ['Recent', stats.receivedInPeriod]].map(([label, value]) => (
          <div key={label} className="px-2 py-3">
            <dd className="text-xl font-semibold tabular-nums">{value}</dd>
            <dt className="text-xs text-muted">{label}</dt>
          </div>
        ))}
      </dl>
      <ul className="divide-y divide-line">
        {forms.map((formType) => (
          <li key={formType}>
            <Link to={`/apps/${slug}/${formType}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-surface-2 sm:px-5">
              <span>{formLabel(formType)}</span>
              <span className="tabular-nums text-muted">{stats.byFormType[formType] ?? 0}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Recent({ applicationName }) {
  const recent = useQuery({
    queryKey: ['submissions', { recent: true }],
    queryFn: ({ signal }) => api.submissions.list({ pageSize: 6, sort: 'receivedAt', dir: 'desc' }, signal),
    retry: false,
  });

  if (recent.isPending) return <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>;
  if (recent.isError) return <ErrorState title="Cannot load recent submissions" error={recent.error} onRetry={() => recent.refetch()} />;
  if (recent.data.items.length === 0) return <EmptyState title="Nothing yet" description="Recent submissions will show up here." />;

  return (
    <ul className="divide-y divide-line">
      {recent.data.items.map((item) => (
        <li key={`${item.application}/${item.submissionId}`}>
          <Link
            to={`/submissions?open=${item.application}/${item.formType}/${item.submissionId}`}
            className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5"
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${item.isRead ? 'bg-transparent' : 'bg-accent'}`} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{contactOf(item.data).title}</span>
              <span className="block truncate text-xs text-muted">{applicationName(item.application)} · {formLabel(item.formType)} · {timeAgo(item.receivedAt)}</span>
            </span>
            <StatusBadge status={item.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function Overview() {
  const { applications } = useSession();
  const [days, setDays] = useState(30);
  const stats = useQuery({
    queryKey: ['stats', { days }],
    queryFn: ({ signal }) => api.stats({ days }, signal),
    placeholderData: keepPreviousData,
    staleTime: 2 * 60_000, // Keep fresh for 2 minutes
    gcTime: 10 * 60_000,   // Keep in cache for 10 minutes
    retry: false,
  });
  const applicationName = (slug) => applications.find((a) => a.slug === slug)?.name ?? slug;

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="mt-1 text-sm text-muted">Activity across {applications.length === 1 ? 'your website' : 'all the websites you can access'}.</p>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted">
        Period
        <select
          aria-label="Period"
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="h-9 rounded-lg border border-line bg-surface px-3 text-fg"
        >
          {RANGES.map((range) => <option key={range} value={range}>Last {range} days</option>)}
        </select>
      </label>
    </div>
  );

  if (stats.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" role="status" aria-label="Loading statistics">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (stats.isError && !stats.data) {
    return <div className="space-y-6">{header}<Card><ErrorState title="Cannot load statistics" error={stats.error} onRetry={() => stats.refetch()} /></Card></div>;
  }

  const { combined, applications: perApp } = stats.data;
  const slugs = Object.keys(perApp);

  if (combined.total === 0) {
    return (
      <div className="space-y-6">
        {header}
        <Card><EmptyState icon={Inbox} title="No submissions yet" description="When visitors submit a form on your websites, the statistics appear here." /></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Submissions" value={combined.total} hint="All time" to="/submissions" />
        <StatCard label="Unread" value={combined.unread} hint="Waiting for a first look" to="/submissions?read=unread" />
        <StatCard label={`Last ${stats.data.days} days`} value={combined.receivedInPeriod} hint="Received in this period" />
        <StatCard label={slugs.length === 1 ? 'Website' : 'Websites'} value={slugs.length} hint={slugs.map(applicationName).join(', ')} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Submissions per day" className="lg:col-span-2"><Suspense fallback={chartFallback}><DailyChart data={combined.daily} days={stats.data.days} /></Suspense></Card>
        <Card title="By status"><StatusBars byStatus={combined.byStatus} /></Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {slugs.length > 1 && (
          <Card title="By website">
            <Suspense fallback={chartFallback}>
              <WebsiteChart totals={Object.fromEntries(slugs.map((slug) => [applicationName(slug), combined.byApplication[slug] ?? 0]))} />
            </Suspense>
          </Card>
        )}
        <Card title="Recent submissions" padded={false} className={slugs.length > 1 ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <Recent applicationName={applicationName} />
        </Card>
      </div>

      <section aria-label="Websites" className={`grid gap-6 ${slugs.length > 1 ? 'md:grid-cols-2 xl:grid-cols-3' : ''}`}>
        {slugs.map((slug) => <ApplicationCard key={slug} slug={slug} name={applicationName(slug)} stats={perApp[slug]} />)}
      </section>

      <p className="text-center text-xs text-muted"><NeutralBadge>Updated live from the API</NeutralBadge></p>
    </div>
  );
}
