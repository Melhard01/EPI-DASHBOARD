import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints.js';
import { ApiError } from '../api/client.js';
import { SessionContext } from './SessionContext.js';
import { hasValidToken } from '../lib/jwt.js';

function stateOf(query) {
  if (query.isSuccess) return 'ready';
  if (!query.isError) return 'loading';
  const error = query.error;
  if (error instanceof ApiError && error.isUnauthorized) return 'unauthenticated';
  if (error instanceof ApiError && error.isForbidden) return 'forbidden';
  return 'error';
}

export default function SessionProvider({ children }) {
  // Only attempt to fetch /me if we have a valid token
  const shouldFetch = hasValidToken();

  const query = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => api.me(signal),
    enabled: shouldFetch,
    retry: false,
    staleTime: 10 * 60_000, // Keep data fresh for 10 minutes
    gcTime: 30 * 60_000,    // Keep in cache for 30 minutes (even when not in use)
  });

  const { status, data, error, refetch } = query;
  const value = useMemo(() => {
    const admin = data ?? null;
    const applications = admin?.applications ?? [];
    return {
      state: stateOf({
        isSuccess: status === 'success',
        isError: status === 'error',
        error: shouldFetch ? error : new ApiError({ status: 401, message: 'Not authenticated' })
      }),
      admin,
      error: shouldFetch ? error : new ApiError({ status: 401, message: 'Not authenticated' }),
      refetch,
      applications,
      statuses: admin?.statuses ?? [],
      isSuperAdmin: admin?.isSuperAdmin === true,
      canAccess: (slug) => applications.some((a) => a.slug === slug),
      application: (slug) => applications.find((a) => a.slug === slug) ?? null,
    };
  }, [status, data, error, refetch, shouldFetch]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
