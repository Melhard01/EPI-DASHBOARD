import { STATUSES, statusLabel } from '../../lib/labels.js';

const STATUS_COLORS = { new: '#3b82f6', in_progress: '#f59e0b', replied: '#10b981', closed: '#64748b', archived: '#a1a1aa' };

/** Status distribution as accessible, plain HTML bars. */
export function StatusBars({ byStatus }) {
  const total = STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
  return (
    <ul className="space-y-3">
      {STATUSES.map((status) => {
        const count = byStatus[status] ?? 0;
        const percent = total === 0 ? 0 : Math.round((count / total) * 100);
        return (
          <li key={status}>
            <div className="mb-1 flex justify-between text-sm">
              <span>{statusLabel(status)}</span>
              <span className="tabular-nums text-muted">{count}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={`${statusLabel(status)} share`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="h-full rounded-full" style={{ width: `${percent}%`, background: STATUS_COLORS[status] }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
