import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PeriodPreset = '24h' | '7d' | '30d';
export type PeriodCustom = { start: number; end: number };
export type Period = PeriodPreset | PeriodCustom;

export type ActiveTab = 'orto' | 'waterflow' | 'settings';
export type Theme = 'light' | 'dark';

interface AppState {
  theme: Theme;
  activeTab: ActiveTab;
  periodOrto: Period;
  periodValve: Period;
  setTheme: (t: Theme) => void;
  setActiveTab: (t: ActiveTab) => void;
  setPeriodOrto: (p: Period) => void;
  setPeriodValve: (p: Period) => void;
}

interface PersistedState {
  theme: Theme;
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      theme: 'light',
      activeTab: 'orto',
      periodOrto: '24h',
      periodValve: '7d',
      setTheme: (theme) => set({ theme }),
      setActiveTab: (activeTab) => set({ activeTab }),
      setPeriodOrto: (periodOrto) => set({ periodOrto }),
      setPeriodValve: (periodValve) => set({ periodValve }),
    }),
    {
      name: 'orto-digitale',
      partialize: (state): PersistedState => ({ theme: state.theme }),
    },
  ),
);

export function isPresetPeriod(p: Period): p is PeriodPreset {
  return typeof p === 'string';
}

export interface ResolvedPeriod {
  t0: number;
  t1: number;
  span: number;
  label: string;
  kind: 'preset' | 'custom';
  preset?: PeriodPreset;
}

export function resolvePeriod(p: Period): ResolvedPeriod {
  const now = Date.now();
  if (isPresetPeriod(p)) {
    if (p === '7d') return { kind: 'preset', preset: p, t0: now - 7 * 86400000, t1: now, span: 7 * 86400000, label: '7g' };
    if (p === '30d') return { kind: 'preset', preset: p, t0: now - 30 * 86400000, t1: now, span: 30 * 86400000, label: '30g' };
    return { kind: 'preset', preset: p, t0: now - 86400000, t1: now, span: 86400000, label: '24h' };
  }
  return {
    kind: 'custom',
    t0: p.start,
    t1: p.end,
    span: Math.max(1, p.end - p.start),
    label: 'custom',
  };
}

export function periodToParams(p: Period): { start: string; stop: string } {
  if (isPresetPeriod(p)) {
    if (p === '7d') return { start: '-7d', stop: 'now()' };
    if (p === '30d') return { start: '-30d', stop: 'now()' };
    return { start: '-24h', stop: 'now()' };
  }
  return { start: new Date(p.start).toISOString(), stop: new Date(p.end).toISOString() };
}
