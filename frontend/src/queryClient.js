import { QueryClient } from '@tanstack/react-query';

/** One factory for the app and the tests (tests pass `retry: false`). */
export function createQueryClient({ retry = false } = {}) {
  return new QueryClient({
    defaultOptions: {
      queries: { retry, refetchOnWindowFocus: false, staleTime: 15_000 },
      mutations: { retry: false },
    },
  });
}
