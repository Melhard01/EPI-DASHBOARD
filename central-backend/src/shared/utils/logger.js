/**
 * Minimal structured logger. Kept dependency-free so it can later be swapped
 * for a dedicated logging library without touching call sites.
 */
function write(level, message, meta) {
  const entry = { time: new Date().toISOString(), level, message, ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = Object.freeze({
  info: (message, meta = {}) => write('info', message, meta),
  warn: (message, meta = {}) => write('warn', message, meta),
  error: (message, meta = {}) => write('error', message, meta),
});
