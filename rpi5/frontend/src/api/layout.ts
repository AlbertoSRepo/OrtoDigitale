import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPut } from './client';
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

/** Salva il layout. Il server rivalida e risponde 400 con i codici di errore
 *  (step 13, §6.2): la validazione client serve al riscontro, non alla difesa. */
export async function putLayout(layout: Layout): Promise<Layout> {
  return apiPut<Layout>('/layout', layout);
}
