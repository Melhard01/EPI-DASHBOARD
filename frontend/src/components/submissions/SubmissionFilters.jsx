import { Search, X } from 'lucide-react';
import Button from '../ui/Button.jsx';
import { controlClass } from '../ui/controlClass.js';
import { formLabel, STATUSES, statusLabel } from '../../lib/labels.js';

const SORTS = [
  { value: 'receivedAt', label: 'Received' },
  { value: 'updatedAt', label: 'Last updated' },
  { value: 'status', label: 'Status' },
  { value: 'formType', label: 'Form' },
  { value: 'application', label: 'Website' },
];

function Labeled({ label, children, className = '' }) {
  return (
    <label className={`flex flex-col gap-1 text-xs font-medium text-muted ${className}`}>
      {label}
      {children}
    </label>
  );
}

/**
 * Presentational filter bar. All values live in the URL (see SubmissionsView), so
 * a filtered list can be bookmarked or shared. The server validates every value.
 */
export default function SubmissionFilters({ state, search, onSearch, onChange, onClear, applications, showApplication, showFormType, hasFilters }) {
  const selectedApp = applications.find((a) => a.slug === state.application);
  const formTypes = selectedApp ? selectedApp.formTypes : [...new Set(applications.flatMap((a) => a.formTypes))];

  return (
    <form role="search" aria-label="Filter submissions" onSubmit={(event) => event.preventDefault()} className="space-y-3 border-b border-line p-4 sm:p-5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input
          type="search"
          aria-label="Search submissions"
          placeholder="Search names, emails, messages, or an ID…"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          maxLength={200}
          className={`${controlClass} pl-9`}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        {showApplication && (
          <Labeled label="Website">
            <select aria-label="Website" className={controlClass} value={state.application} onChange={(event) => onChange({ application: event.target.value, formType: '' })}>
              <option value="">All websites</option>
              {applications.map((a) => (
                <option key={a.slug} value={a.slug}>{a.name}</option>
              ))}
            </select>
          </Labeled>
        )}
        {showFormType && (
          <Labeled label="Form">
            <select aria-label="Form" className={controlClass} value={state.formType} onChange={(event) => onChange({ formType: event.target.value })}>
              <option value="">All forms</option>
              {formTypes.map((type) => (
                <option key={type} value={type}>{formLabel(type)}</option>
              ))}
            </select>
          </Labeled>
        )}
        <Labeled label="Status">
          <select aria-label="Status" className={controlClass} value={state.status} onChange={(event) => onChange({ status: event.target.value })}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{statusLabel(s)}</option>
            ))}
          </select>
        </Labeled>
        <Labeled label="Read state">
          <select aria-label="Read state" className={controlClass} value={state.read} onChange={(event) => onChange({ read: event.target.value })}>
            <option value="">Read and unread</option>
            <option value="unread">Unread only</option>
            <option value="read">Read only</option>
          </select>
        </Labeled>
        <Labeled label="From">
          <input type="date" aria-label="From date" className={controlClass} value={state.from} max={state.to || undefined} onChange={(event) => onChange({ from: event.target.value })} />
        </Labeled>
        <Labeled label="To">
          <input type="date" aria-label="To date" className={controlClass} value={state.to} min={state.from || undefined} onChange={(event) => onChange({ to: event.target.value })} />
        </Labeled>
        <Labeled label="Sort by">
          <select aria-label="Sort by" className={controlClass} value={state.sort} onChange={(event) => onChange({ sort: event.target.value })}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </Labeled>
        <Labeled label="Order">
          <select aria-label="Order" className={controlClass} value={state.dir} onChange={(event) => onChange({ dir: event.target.value })}>
            <option value="desc">Newest / Z–A first</option>
            <option value="asc">Oldest / A–Z first</option>
          </select>
        </Labeled>
      </div>

      {hasFilters && (
        <Button size="sm" variant="ghost" onClick={onClear}>
          <X className="h-4 w-4" aria-hidden="true" /> Clear filters
        </Button>
      )}
    </form>
  );
}
