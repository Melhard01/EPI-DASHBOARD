import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];

/** Custom responsive tooltip for the pie chart */
function ResponsiveTooltip({ active, payload }) {
  if (active && payload?.length) {
    return (
      <div className="rounded-lg bg-surface border border-line px-2 py-1 sm:px-3 sm:py-1.5 shadow-elevated">
        <p className="text-xs sm:text-sm font-medium text-fg">{payload[0].name}</p>
        <p className="text-xs sm:text-sm text-muted">{payload[0].value} submissions</p>
      </div>
    );
  }
  return null;
}

/** Share of all submissions per website (only useful with more than one website). */
export default function WebsiteChart({ totals }) {
  const data = Object.entries(totals).map(([name, value]) => ({ name, value })).filter((d) => d.value > 0);
  const summary = data.map((d) => `${d.name}: ${d.value}`).join(', ');
  return (
    <div className="flex w-full flex-col items-center justify-center gap-4 p-4 sm:gap-6 sm:p-6 lg:flex-row lg:items-start lg:justify-start lg:p-0">
      {/* Responsive Chart Container */}
      <div
        role="img"
        aria-label={`Submissions per website: ${summary || 'none'}`}
        className="h-48 w-48 shrink-0 sm:h-56 sm:w-56 lg:h-64 lg:w-64"
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="35%"
              outerRadius="85%"
              paddingAngle={2}
              stroke="none"
            >
              {data.map((entry, i) => <Cell key={entry.name} fill={PALETTE[i % PALETTE.length]} />)}
            </Pie>
            <Tooltip content={<ResponsiveTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Responsive Legend */}
      <div className="w-full space-y-2 sm:space-y-2.5 lg:w-auto lg:flex-1 lg:pl-6">
        {data.map((entry, i) => (
          <div key={entry.name} className="flex items-center justify-between gap-3 sm:gap-4 px-3 py-2 sm:py-2.5 rounded-lg bg-surface-2 hover:bg-surface-3 transition-colors">
            <span className="flex items-center gap-2 min-w-0 flex-1">
              <span
                className="h-3 w-3 shrink-0 rounded-full sm:h-3.5 sm:w-3.5"
                style={{ background: PALETTE[i % PALETTE.length] }}
                aria-hidden="true"
              />
              <span className="text-xs sm:text-sm truncate font-medium text-fg">{entry.name}</span>
            </span>
            <span className="shrink-0 text-xs sm:text-sm font-semibold tabular-nums text-fg ml-2">{entry.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

