import { createContext, useContext } from 'react';

export const SessionContext = createContext(null);

/**
 * The signed-in admin as the BACKEND describes them (GET /me).
 *   state: 'loading' | 'ready' | 'unauthenticated' | 'forbidden' | 'error'
 * The UI uses this only to decide what to SHOW. The backend enforces every
 * permission on every request regardless of what the UI displays.
 */
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside <SessionProvider>');
  return session;
}
