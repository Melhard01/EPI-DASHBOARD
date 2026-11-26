import { statusLabel } from '../../lib/labels.js';

const STATUS_STYLES = {
  new: 'bg-accent-light text-accent dark:bg-accent/30 dark:text-accent',
  in_progress: 'bg-warning/15 text-warning dark:bg-warning/25 dark:text-warning-hover',
  replied: 'bg-success/15 text-success dark:bg-success/25 dark:text-success-hover',
  closed: 'bg-surface-3 text-muted dark:bg-surface-4 dark:text-muted-light',
  archived: 'bg-muted-light/20 text-muted dark:bg-muted-light/15 dark:text-muted-light',
};

export function Badge({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${className}`}>{children}</span>
  );
}

export function StatusBadge({ status }) {
  return <Badge className={STATUS_STYLES[status] ?? 'bg-surface-3 text-muted'}>{statusLabel(status)}</Badge>;
}

export function NeutralBadge({ children }) {
  return <Badge className="bg-surface-3 text-muted font-medium">{children}</Badge>;
}
