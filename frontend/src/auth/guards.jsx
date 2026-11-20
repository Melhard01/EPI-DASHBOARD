import { useParams } from 'react-router';
import { useSession } from './SessionContext.js';
import { FullPageSpinner, ErrorState } from '../components/ui/States.jsx';
import { SessionExpired, NotAnAdmin, Forbidden, NotFound } from '../pages/StatusPages.jsx';

/** Renders its children only for a signed-in, active administrator. */
export function RequireSession({ children }) {
  const session = useSession();
  switch (session.state) {
    case 'loading':
      return <FullPageSpinner />;
    case 'unauthenticated':
      return <SessionExpired onRetry={() => window.location.reload()} />;
    case 'forbidden':
      return <NotAnAdmin />;
    case 'error':
      return (
        <div className="flex min-h-screen items-center justify-center bg-surface-2">
          <ErrorState title="Cannot load your account" error={session.error} onRetry={() => session.refetch()} />
        </div>
      );
    default:
      return children;
  }
}

/**
 * Guards /apps/:application/:formType. An application the admin may not use is
 * "not allowed"; a form the application does not have is "not found".
 * (The backend enforces the same rules: this only avoids pointless requests.)
 */
export function RequireApplication({ children }) {
  const { application: slug, formType } = useParams();
  const session = useSession();
  const application = session.application(slug);
  if (!application) {
    return <Forbidden message="You do not have access to this website." />;
  }
  if (!application.formTypes.includes(formType)) return <NotFound />;
  return children;
}

export function RequireSuperAdmin({ children }) {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <Forbidden message="Only Super Admins can open this page." />;
  return children;
}
