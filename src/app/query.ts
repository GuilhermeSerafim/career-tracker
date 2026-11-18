import { QueryClient } from '@tanstack/react-query';

/** One client per application runtime; never persist this cache. */
export function createAppQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}
