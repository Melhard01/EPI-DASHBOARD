import { STATUSES, statusLabel } from '../../lib/labels.js';

const STATUS_COLORS = {
  new: '#d4a574',      // Golden accent
  in_progress: '#d9a34a', // Warning
  replied: '#86c06b',  // Success
  closed: '#8b7d73',   // Muted
  archived: '#bbb3a8'  // Light muted
};

/** Status distribution as accessible, plain HTML bars. */
export function StatusBars({ byStatus }) {
  const total = STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
  return (
    <ul className="space-y-4">
      {STATUSES.map((status) => {
        const count = byStatus[status] ?? 0;
        const percent = total === 0 ? 0 : Math.round((count / total) * 100);
        return (
          <li key={status}>
            <div className="mb-2 flex justify-between text-sm">
              <span className="font-medium text-fg">{statusLabel(status)}</span>
              <span className="tabular-nums font-semibold text-muted">{count}</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={`${statusLabel(status)} share`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="h-full rounded-full transition-all duration-500" style={{ width: `${percent}%`, background: STATUS_COLORS[status] }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
