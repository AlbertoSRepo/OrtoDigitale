import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';
import type { OpenValveAck, ValveCumulative, ValveInterval, ValveState } from './types';
import { periodToParams, type Period } from '../state/store';

export function useValveState() {
  return useQuery({
    queryKey: ['valve', 'state'],
    queryFn: () => apiGet<ValveState>('/valve/state'),
    refetchInterval: 2000,
  });
}

export function useValveIntervals(period: Period) {
  const params = periodToParams(period);
  return useQuery({
    queryKey: ['valve', 'intervals', params.start, params.stop],
    queryFn: () => apiGet<ValveInterval[]>('/valve/intervals', params),
    refetchInterval: 10_000,
  });
}

export function useValveCumulative(period: Period) {
  const params = periodToParams(period);
  return useQuery({
    queryKey: ['valve', 'cumulative', params.start, params.stop],
    queryFn: () => apiGet<ValveCumulative>('/valve/cumulative', params),
    refetchInterval: 10_000,
  });
}

export function useOpenValve() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (durationSeconds?: number) =>
      apiPost<OpenValveAck>('/valve/on', durationSeconds ? { duration_seconds: durationSeconds } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['valve'] });
    },
  });
}

export function useCloseValve() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<OpenValveAck>('/valve/off'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['valve'] });
    },
  });
}
