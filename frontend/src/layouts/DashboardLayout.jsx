import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { Inbox, LayoutDashboard, Menu, ScrollText, Settings as SettingsIcon, Users, X } from 'lucide-react';
import { useSession } from '../auth/SessionContext.js';
import { formLabel } from '../lib/labels.js';
import { NeutralBadge } from '../components/ui/Badge.jsx';

const linkClass = ({ isActive }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive ? 'bg-accent/10 text-accent' : 'text-fg hover:bg-surface-3'
  }`;

function SidebarNav({ onNavigate }) {
  const { applications, isSuperAdmin } = useSession();
  return (
    <nav aria-label="Main" className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      <div className="space-y-1">
        <NavLink to="/" end className={linkClass} onClick={onNavigate}>
          <LayoutDashboard className="h-4 w-4" aria-hidden="true" /> Overview
        </NavLink>
        <NavLink to="/submissions" className={linkClass} onClick={onNavigate}>
          <Inbox className="h-4 w-4" aria-hidden="true" /> All submissions
        </NavLink>
      </div>

      {applications.map((application) => (
        <div key={application.slug} className="space-y-1">
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">{application.name}</p>
          {application.formTypes.map((formType) => (
            <NavLink key={formType} to={`/apps/${application.slug}/${formType}`} className={linkClass} onClick={onNavigate}>
              <span className="w-4" aria-hidden="true" />
              {formLabel(formType)}
            </NavLink>
          ))}
        </div>
      ))}

      <div className="space-y-1">
        <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">Administration</p>
        {isSuperAdmin && (
          <>
            <NavLink to="/team" className={linkClass} onClick={onNavigate}>
              <Users className="h-4 w-4" aria-hidden="true" /> Team management
            </NavLink>
            <NavLink to="/audit" className={linkClass} onClick={onNavigate}>
              <ScrollText className="h-4 w-4" aria-hidden="true" /> Audit logs
            </NavLink>
          </>
        )}
        <NavLink to="/settings" className={linkClass} onClick={onNavigate}>
          <SettingsIcon className="h-4 w-4" aria-hidden="true" /> Settings
        </NavLink>
      </div>
    </nav>
  );
}

function AccountChip() {
  const { admin, isSuperAdmin } = useSession();
  return (
    <div className="border-t border-line px-4 py-3">
      <p className="truncate text-sm font-medium" title={admin.email}>{admin.displayName || admin.email}</p>
      {admin.displayName && <p className="truncate text-xs text-muted">{admin.email}</p>}
      <div className="mt-2">
        <NeutralBadge>{isSuperAdmin ? 'Super Admin' : 'Website admin'}</NeutralBadge>
      </div>
    </div>
  );
}

export default function DashboardLayout() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event) => event.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-14 items-center px-5 text-base font-semibold">Central Admin</div>
        <SidebarNav />
        <AccountChip />
      </aside>

      {/* Tablet / mobile slide-over menu */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 flex bg-slate-900/50 lg:hidden" onMouseDown={(event) => event.target === event.currentTarget && setMenuOpen(false)}>
          <aside role="dialog" aria-modal="true" aria-label="Navigation menu" className="flex w-72 max-w-[85vw] flex-col bg-surface shadow-xl">
            <div className="flex h-14 items-center justify-between px-5">
              <span className="text-base font-semibold">Central Admin</span>
              <button type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)} className="rounded-lg p-1.5 text-muted hover:bg-surface-3">
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <SidebarNav onNavigate={() => setMenuOpen(false)} />
            <AccountChip />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 lg:hidden">
          <button type="button" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)} className="rounded-lg p-2 hover:bg-surface-3">
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <span className="font-semibold">Central Admin</span>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
