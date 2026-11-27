import { GaugeChart } from './GaugeChart.jsx';
import { BarcodeProgress } from './BarcodeProgress.jsx';

export function GaugeCard({ title = 'Campaign Overview', data = { completed: 35, failed: 25, done: '60', percent: 58.3, calls: 24, sms: 35 } }) {
  return (
    <div className="card-premium bg-black text-white rounded-2xl p-6" style={{ backgroundColor: '#050505', color: '#ffffff' }}>
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase">{title}</h3>
        <button className="text-white hover:text-gray-300">···</button>
      </div>

      <div className="flex justify-between text-xs text-gray-400 mb-4">
        <div>
          <div className="text-sm font-semibold text-white">{data.completed}</div>
          <div>Done</div>
        </div>
        <div>
          <div className="text-sm font-semibold text-white">{data.failed}</div>
          <div>Sent</div>
        </div>
      </div>

      <div className="mb-6">
        <GaugeChart percentage={parseInt(data.done)} label="Done" value={data.done} />
      </div>

      <div className="flex justify-around text-xs text-gray-400 mt-4">
        <div>
          <div className="text-white font-semibold">{data.calls}</div>
          <div>Calls</div>
        </div>
        <div>
          <div className="text-white font-semibold">{data.percent}%</div>
          <div>Done</div>
        </div>
        <div>
          <div className="text-white font-semibold">{data.sms}</div>
          <div>SMS</div>
        </div>
      </div>
    </div>
  );
}

export function MetricCard({ title = 'SMS', percentage = 52, stats = { done: 19, total: 36, left: 17 } }) {
  return (
    <div className="card-premium bg-white rounded-2xl p-6">
      <div className="flex justify-between items-start mb-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase">{title}</h3>
        <button className="text-gray-400 hover:text-gray-600">···</button>
      </div>

      <div className="flex items-baseline gap-1 mb-3">
        <span className="text-4xl font-light text-black">{percentage}</span>
        <span className="text-sm text-gray-500">%</span>
      </div>

      <div className="flex gap-4 text-xs text-gray-500 mb-4">
        <div>
          <div className="font-semibold text-black">{stats.done}</div>
          <div>Done</div>
        </div>
        <div>
          <div className="font-semibold text-black">{stats.total}</div>
          <div>Total</div>
        </div>
        <div>
          <div className="font-semibold text-black">{stats.left}</div>
          <div>Left</div>
        </div>
      </div>

      <BarcodeProgress percentage={percentage / 100} className="w-full" />
    </div>
  );
}

export function CampaignCard({
  title = 'Active Campaign',
  description = 'Calls completed',
  percentage = 68.13,
  stats = { completed: 182, remaining: 56 },
  statusDots = [
    { label: 'Done', count: 124, color: '#9670d9' },
    { label: 'In Queue', count: 25, color: '#080808' },
    { label: 'Processing', count: 33, color: '#d7d7d7' }
  ]
}) {
  return (
    <div className="card-premium bg-white rounded-2xl p-6">
      <div className="flex justify-between items-start mb-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase">{title}</h3>
        <button className="text-gray-400 hover:text-gray-600">···</button>
      </div>

      <p className="text-xs text-gray-500 mb-2">{description}</p>

      <div className="flex justify-between items-baseline mb-4">
        <div className="flex items-baseline gap-1">
          <span className="text-4xl font-light text-black">{percentage}</span>
          <span className="text-sm text-gray-500">%</span>
        </div>
        <div className="text-right text-xs text-gray-500">
          <div className="font-semibold text-black">{stats.completed}</div>
          <div>Completed</div>
        </div>
      </div>

      <BarcodeProgress percentage={percentage / 100} className="w-full mb-4" />

      <div className="flex gap-3 text-xs mb-6">
        {statusDots.map((dot, i) => (
          <div key={i} className="flex items-center gap-1">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: dot.color }}
            />
            <span className="text-gray-600">{dot.count}</span>
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <button className="flex-1 bg-black text-white py-2 rounded-lg text-sm font-medium hover:bg-gray-900 transition-colors">
          Resume
        </button>
        <button className="flex-1 bg-gray-100 text-gray-600 py-2 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}
