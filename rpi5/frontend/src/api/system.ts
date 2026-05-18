import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';
import type { CancelAck, ShutdownAck, SystemHealth, SystemStats } from './types';

export function useSystemHealth() {
  return useQuery({
    queryKey: ['system', 'health'],
    queryFn: () => apiGet<SystemHealth>('/system/health'),
    refetchInterval: 10_000,
  });
}

export function useSystemStats() {
  return useQuery({
    queryKey: ['system', 'stats'],
    queryFn: () => apiGet<SystemStats>('/system/stats'),
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: 1,
  });
}

export function useShutdown() {
  return useMutation({
    mutationFn: () => apiPost<ShutdownAck>('/system/shutdown', { confirm: 'shutdown' }),
  });
}

export function useShutdownCancel() {
  return useMutation({
    mutationFn: () => apiPost<CancelAck>('/system/shutdown/cancel'),
  });
}
