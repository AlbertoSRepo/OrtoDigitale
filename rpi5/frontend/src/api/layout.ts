import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { Layout } from './types';

/** Il layout cambia solo quando qualcuno lo modifica a mano (step 13): non serve
 *  ripollare come i sensori. */
export function useLayout() {
  return useQuery({
    queryKey: ['layout'],
    queryFn: () => apiGet<Layout>('/layout'),
    staleTime: 5 * 60_000,
  });
}
