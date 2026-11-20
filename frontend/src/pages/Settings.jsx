import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { useSession } from '../auth/SessionContext.js';
import Card from '../components/ui/Card.jsx';
import { NeutralBadge } from '../components/ui/Badge.jsx';
import { config } from '../config.js';
import { formLabel } from '../lib/labels.js';
import { THEMES, getTheme, setTheme } from '../lib/theme.js';

const THEME_LABELS = { system: 'Match my device', light: 'Light', dark: 'Dark' };

export default function Settings() {
  const { admin, isSuperAdmin, applications } = useSession();
  const [theme, setThemeState] = useState(getTheme);

  const choose = (value) => {
    setTheme(value);
    setThemeState(value);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted">Your account and how the dashboard looks for you.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Your account">
          <dl className="space-y-3 text-sm">
            <div><dt className="text-muted">Email</dt><dd className="font-medium">{admin.email}</dd></div>
            {admin.displayName && <div><dt className="text-muted">Name</dt><dd className="font-medium">{admin.displayName}</dd></div>}
            <div><dt className="text-muted">Role</dt><dd><NeutralBadge>{isSuperAdmin ? 'Super Admin' : 'Website admin'}</NeutralBadge></dd></div>
          </dl>
          <p className="mt-4 text-xs text-muted">Sign-in is handled by Cloudflare Access. Passwords are never stored by this dashboard.</p>
          {config.accessLogoutUrl && (
            <a href={config.accessLogoutUrl} className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg border border-line px-4 text-sm font-medium hover:bg-surface-3">
              <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
            </a>
          )}
        </Card>

        <Card title="Appearance">
          <fieldset>
            <legend className="sr-only">Theme</legend>
            <div className="space-y-2">
              {THEMES.map((value) => (
                <label key={value} className="flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-sm has-[:checked]:border-accent">
                  <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => choose(value)} className="accent-[var(--accent)]" />
                  {THEME_LABELS[value]}
                </label>
              ))}
            </div>
          </fieldset>
        </Card>

        <Card title="What you can access" className="lg:col-span-2">
          {applications.length === 0 ? (
            <p className="text-sm text-muted">You are not assigned to any website yet. Ask a Super Admin.</p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {applications.map((application) => (
                <li key={application.slug} className="rounded-lg border border-line p-3">
                  <p className="text-sm font-medium">{application.name}</p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {application.formTypes.map((type) => <NeutralBadge key={type}>{formLabel(type)}</NeutralBadge>)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-muted">
            {isSuperAdmin ? 'As a Super Admin you can use every website and manage administrators.' : 'Access is set by a Super Admin and enforced by the server.'}
          </p>
        </Card>
      </div>
    </div>
  );
}
