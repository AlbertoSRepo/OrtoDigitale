import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { IrrigationForecast } from './types';

export function useIrrigationForecast() {
  return useQuery({
    queryKey: ['irrigation', 'forecast'],
    queryFn: () => apiGet<IrrigationForecast>('/irrigation/forecast'),
    refetchInterval: 5 * 60_000,
    staleTime: 5 * 60_000,
  });
}
