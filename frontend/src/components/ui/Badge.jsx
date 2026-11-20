import { statusLabel } from '../../lib/labels.js';

const STATUS_STYLES = {
  new: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300',
  in_progress: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  replied: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  closed: 'bg-slate-200 text-slate-700 dark:bg-slate-500/25 dark:text-slate-300',
  archived: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-500/20 dark:text-zinc-400',
};

export function Badge({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>
  );
}

export function StatusBadge({ status }) {
  return <Badge className={STATUS_STYLES[status] ?? 'bg-slate-200 text-slate-700'}>{statusLabel(status)}</Badge>;
}

export function NeutralBadge({ children }) {
  return <Badge className="bg-surface-3 text-muted">{children}</Badge>;
}
