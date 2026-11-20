import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];

/** Share of all submissions per website (only useful with more than one website). */
export default function WebsiteChart({ totals }) {
  const data = Object.entries(totals).map(([name, value]) => ({ name, value })).filter((d) => d.value > 0);
  const summary = data.map((d) => `${d.name}: ${d.value}`).join(', ');
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row">
      <div role="img" aria-label={`Submissions per website: ${summary || 'none'}`} className="h-44 w-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={44} outerRadius={70} paddingAngle={2} stroke="none">
              {data.map((entry, i) => <Cell key={entry.name} fill={PALETTE[i % PALETTE.length]} />)}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="w-full space-y-2 text-sm">
        {data.map((entry, i) => (
          <li key={entry.name} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden="true" />
              {entry.name}
            </span>
            <span className="font-medium tabular-nums">{entry.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

