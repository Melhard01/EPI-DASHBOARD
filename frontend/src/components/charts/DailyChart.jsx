import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const shortDate = (iso) => {
  const [, month, day] = String(iso).split('-');
  return `${day}/${month}`;
};

/** Submissions per day. The wrapper carries a text summary for screen readers. */
export default function DailyChart({ data, days }) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  return (
    <div role="img" aria-label={`Submissions per day over the last ${days} days: ${total} in total`} className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id="dailyFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.25} vertical={false} />
          <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
          <Tooltip labelFormatter={(label) => label} formatter={(value) => [value, 'Submissions']} />
          <Area type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={2} fill="url(#dailyFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

