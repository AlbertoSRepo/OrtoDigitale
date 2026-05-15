import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { SensorLast, SensorTrend } from './types';
import { periodToParams, type Period } from '../state/store';

export function useSensorsLast() {
  return useQuery({
    queryKey: ['sensors', 'last'],
    queryFn: () => apiGet<SensorLast[]>('/sensors/last'),
    refetchInterval: 5000,
  });
}

export function useSensorsTrend(period: Period, sensorId?: string) {
  const params = periodToParams(period);
  return useQuery({
    queryKey: ['sensors', 'trend', params.start, params.stop, sensorId ?? 'all'],
    queryFn: () => apiGet<SensorTrend>('/sensors/trend', { ...params, ...(sensorId ? { sensor_id: sensorId } : {}) }),
    staleTime: 10_000,
  });
}
