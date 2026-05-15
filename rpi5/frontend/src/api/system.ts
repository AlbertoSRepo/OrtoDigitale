import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from './client';
import type { CancelAck, ShutdownAck, SystemHealth } from './types';

export function useSystemHealth() {
  return useQuery({
    queryKey: ['system', 'health'],
    queryFn: () => apiGet<SystemHealth>('/system/health'),
    refetchInterval: 10_000,
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
