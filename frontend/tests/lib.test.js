import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatDate, formatDateTime, nextDay, shortId, timeAgo } from '../src/lib/format.js';
import { actionLabel, contactOf, fieldLabel, formLabel, statusLabel, summaryOf } from '../src/lib/labels.js';
import { applyTheme, getTheme, setTheme } from '../src/lib/theme.js';
import { reloadToSignIn } from '../src/lib/session.js';

describe('format', () => {
  test('nextDay handles month and year ends and rejects garbage', () => {
    expect(nextDay('2026-11-19')).toBe('2026-11-20');
    expect(nextDay('2026-11-30')).toBe('2026-12-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(nextDay('not-a-date')).toBeUndefined();
  });

  test('timeAgo gives readable relative times', () => {
    const now = Date.UTC(2026, 10, 19, 12, 0, 0);
    const ago = (seconds) => new Date(now - seconds * 1000).toISOString();
    expect(timeAgo(ago(10), now)).toBe('just now');
    expect(timeAgo(ago(60), now)).toBe('1 minute ago');
    expect(timeAgo(ago(5 * 60), now)).toBe('5 minutes ago');
    expect(timeAgo(ago(3600), now)).toBe('1 hour ago');
    expect(timeAgo(ago(3 * 3600), now)).toBe('3 hours ago');
    expect(timeAgo(ago(2 * 86400), now)).toBe('2 days ago');
    expect(timeAgo(ago(30 * 86400), now)).toBe(formatDate(ago(30 * 86400)));
    expect(timeAgo(null, now)).toBe('—');
  });

  test('missing or invalid dates render as a dash, never "Invalid Date"', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDateTime('garbage')).toBe('—');
    expect(timeAgo('garbage')).toBe('—');
    expect(shortId(undefined)).toBe('—');
    expect(shortId('12345678-abcd')).toBe('12345678');
  });
});

describe('labels', () => {
  test('known forms, fields, statuses and actions have friendly names', () => {
    expect(formLabel('contact-sales')).toBe('Contact Sales');
    expect(formLabel('partnerships')).toBe('Partnerships');
    expect(fieldLabel('useCase')).toBe('Use case');
    expect(fieldLabel('userRange')).toBe('Number of users');
    expect(statusLabel('in_progress')).toBe('In progress');
    expect(actionLabel('submission.deleted')).toBe('Submission deleted');
  });

  test('unknown values get a readable fallback (new forms work without code changes)', () => {
    expect(formLabel('press-kit-request')).toBe('Press Kit Request');
    expect(fieldLabel('preferredContactMethod')).toBe('Preferred Contact Method');
    expect(statusLabel('on_hold')).toBe('On Hold');
    expect(actionLabel('thing.happened')).toBe('Thing Happened');
  });

  test('contactOf and summaryOf work for every form shape', () => {
    expect(contactOf({ name: 'Ada', email: 'a@b.co' })).toEqual({ name: 'Ada', email: 'a@b.co', title: 'Ada' });
    expect(contactOf({ firstName: 'Kat', lastName: 'J', workEmail: 'k@j.co' })).toEqual({ name: 'Kat J', email: 'k@j.co', title: 'Kat J' });
    expect(contactOf({ email: 'wait@list.co' })).toEqual({ name: '', email: 'wait@list.co', title: 'wait@list.co' });
    expect(contactOf({}).title).toBe('—');
    expect(summaryOf({ company: 'Acme', product: 'X' })).toBe('Acme');
    expect(summaryOf({ organization: 'Umbrella' })).toBe('Umbrella');
    expect(summaryOf({ userRange: '1-50' })).toBe('1-50');
    expect(summaryOf({ email: 'x' })).toBe('');
  });
});

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });
  afterEach(() => vi.unstubAllGlobals());

  test('defaults to "system", persists the choice, and toggles the dark class', () => {
    expect(getTheme()).toBe('system');
    setTheme('dark');
    expect(getTheme()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    setTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('"system" follows the device preference', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    applyTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    applyTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('an unknown saved value falls back to "system"; unavailable storage does not crash', () => {
    localStorage.setItem('admin:theme', 'neon');
    expect(getTheme()).toBe('system');
    const broken = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => setTheme('dark')).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    broken.mockRestore();
  });
});

describe('reloadToSignIn', () => {
  const originalLocation = window.location;
  beforeEach(() => {
    sessionStorage.clear();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload: vi.fn() } });
  });
  afterEach(() => Object.defineProperty(window, 'location', { configurable: true, value: originalLocation }));

  test('reloads once, then refuses to loop within 15 seconds', () => {
    expect(reloadToSignIn()).toBe(true);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(reloadToSignIn()).toBe(false);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  test('allows another reload after the guard interval', () => {
    sessionStorage.setItem('admin:last-auth-reload', String(Date.now() - 20_000));
    expect(reloadToSignIn()).toBe(true);
  });
});
