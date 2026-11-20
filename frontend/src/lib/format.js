const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateTime.format(date);
}

export function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateOnly.format(date);
}

/** "5 minutes ago" style text; falls back to the date after a week. */
export function timeAgo(iso, now = Date.now()) {
  if (!iso) return '—';
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return '—';
  if (seconds < 45) return 'just now';
  const units = [['minute', 60], ['hour', 3600], ['day', 86400]];
  for (let i = units.length - 1; i >= 0; i--) {
    const [unit, size] = units[i];
    if (seconds >= size) {
      const value = Math.floor(seconds / size);
      if (unit === 'day' && value > 7) return formatDate(iso);
      return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
    }
  }
  return '1 minute ago';
}

export const shortId = (id) => (id ? String(id).slice(0, 8) : '—');

/** YYYY-MM-DD for the day after the given YYYY-MM-DD (the API's `to` is exclusive). */
export function nextDay(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
