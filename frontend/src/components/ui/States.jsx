import { AlertTriangle, Inbox } from 'lucide-react';
import Button from './Button.jsx';

export function Spinner({ label = 'Loading…', className = '' }) {
  return (
    <div role="status" aria-live="polite" className={`flex items-center justify-center gap-3 py-10 text-sm text-muted ${className}`}>
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function FullPageSpinner({ label = 'Loading dashboard…' }) {
  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-surface-2">
      <Spinner label={label} />
    </div>
  );
}

export function Skeleton({ className = '' }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-lg bg-surface-3 ${className}`} />;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <span className="rounded-full bg-surface-3 p-3 text-muted">
        <Icon className="h-6 w-6" aria-hidden="true" />
      </span>
      <p className="text-sm font-semibold">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}

/** Shows an ApiError (or any Error) with a retry button. Never shows raw server internals: the API only sends safe messages. */
export function ErrorState({ error, title = 'Something went wrong', onRetry }) {
  const message = error?.message || 'An unexpected error occurred.';
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <span className="rounded-full bg-red-100 p-3 text-red-700 dark:bg-red-500/20 dark:text-red-300">
        <AlertTriangle className="h-6 w-6" aria-hidden="true" />
      </span>
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-md text-sm text-muted">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      )}
    </div>
  );
}

/** Inline error for forms and dialogs. */
export function InlineError({ children }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
      {children}
    </p>
  );
}
