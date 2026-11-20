import { Link } from 'react-router';
import { LockKeyhole, SearchX, ShieldAlert } from 'lucide-react';
import Button from '../components/ui/Button.jsx';

function Screen({ icon: Icon, title, children, actions, fullPage = false }) {
  return (
    <div className={`flex items-center justify-center px-4 ${fullPage ? 'min-h-screen bg-surface-2' : 'py-16'}`}>
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 text-center shadow-sm">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-3 text-muted">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </span>
        <h1 className="text-lg font-semibold">{title}</h1>
        <div className="mt-2 space-y-2 text-sm text-muted">{children}</div>
        {actions && <div className="mt-6 flex justify-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** The session is gone (Cloudflare Access expired or never started). */
export function SessionExpired({ onRetry }) {
  return (
    <Screen fullPage icon={LockKeyhole} title="Please sign in again" actions={<Button variant="primary" onClick={onRetry}>Sign in</Button>}>
      <p>Your session has expired or you are not signed in.</p>
      <p>In local development this also means the backend did not receive a development token (see the frontend README).</p>
    </Screen>
  );
}

/** Signed in with Cloudflare Access, but not an active administrator. */
export function NotAnAdmin({ email }) {
  return (
    <Screen fullPage icon={ShieldAlert} title="No access to this dashboard">
      <p>{email ? `The account ${email} is` : 'This account is'} not registered as an administrator, or has been disabled.</p>
      <p>Ask a Super Admin to add you.</p>
    </Screen>
  );
}

/** Signed in, but not allowed to see this page or website. */
export function Forbidden({ message = 'You do not have permission to view this page.' }) {
  return (
    <Screen icon={ShieldAlert} title="Not allowed" actions={<Link to="/" className="text-sm font-medium text-accent hover:underline">Back to overview</Link>}>
      <p>{message}</p>
    </Screen>
  );
}

export function NotFound() {
  return (
    <Screen icon={SearchX} title="Page not found" actions={<Link to="/" className="text-sm font-medium text-accent hover:underline">Back to overview</Link>}>
      <p>This page does not exist.</p>
    </Screen>
  );
}
