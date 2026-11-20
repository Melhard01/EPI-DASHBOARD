import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints.js';
import { ApiError } from '../api/client.js';
import { SessionContext } from './SessionContext.js';

function stateOf(query) {
  if (query.isSuccess) return 'ready';
  if (!query.isError) return 'loading';
  const error = query.error;
  if (error instanceof ApiError && error.isUnauthorized) return 'unauthenticated';
  if (error instanceof ApiError && error.isForbidden) return 'forbidden';
  return 'error';
}

export default function SessionProvider({ children }) {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => api.me(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const { status, data, error, refetch } = query;
  const value = useMemo(() => {
    const admin = data ?? null;
    const applications = admin?.applications ?? [];
    return {
      state: stateOf({ isSuccess: status === 'success', isError: status === 'error', error }),
      admin,
      error,
      refetch,
      applications,
      statuses: admin?.statuses ?? [],
      isSuperAdmin: admin?.isSuperAdmin === true,
      canAccess: (slug) => applications.some((a) => a.slug === slug),
      application: (slug) => applications.find((a) => a.slug === slug) ?? null,
    };
  }, [status, data, error, refetch]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
