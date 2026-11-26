import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];

/** Share of all submissions per website (only useful with more than one website). */
export default function WebsiteChart({ totals }) {
  const data = Object.entries(totals).map(([name, value]) => ({ name, value })).filter((d) => d.value > 0);
  const summary = data.map((d) => `${d.name}: ${d.value}`).join(', ');
  return (
    <div className="flex w-full flex-col items-center gap-4 md:gap-6 lg:flex-row lg:items-start">
      {/* Responsive Chart Container */}
      <div
        role="img"
        aria-label={`Submissions per website: ${summary || 'none'}`}
        className="h-40 w-40 shrink-0 sm:h-48 sm:w-48 lg:h-56 lg:w-56"
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
            <Tooltip formatter={(value) => `${value} submissions`} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Responsive Legend */}
      <ul className="w-full space-y-2 text-sm md:space-y-3 md:text-base lg:w-auto lg:flex-1">
        {data.map((entry, i) => (
          <li key={entry.name} className="flex items-center justify-between gap-3 md:gap-4">
            <span className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full md:h-3 md:w-3"
                style={{ background: PALETTE[i % PALETTE.length] }}
                aria-hidden="true"
              />
              <span className="truncate font-medium">{entry.name}</span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums">{entry.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

