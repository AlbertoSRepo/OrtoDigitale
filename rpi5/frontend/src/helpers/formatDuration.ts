export function fmtDurationShort(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const sr = s % 60;
  if (m < 60) return sr ? `${m}m ${sr}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return mr ? `${h}h ${mr}m` : `${h}h`;
}

export function fmtClock(seconds: number): [string, string] {
  const m = Math.floor(seconds / 60);
  const s = Math.max(0, Math.floor(seconds % 60));
  return [String(m).padStart(2, '0'), String(s).padStart(2, '0')];
}

export function fmtHM(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// fmtRelative (formatDate.ts) guarda al passato ('5m fa'). Qui serve il verso
// opposto per la previsione della prossima irrigazione ('fra 25 min'): non va
// riusata, perché per un istante futuro fmtRelative risponde solo 'in arrivo'.
export function fmtFraQuanto(iso: string | null | undefined, ora: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.round((t - ora) / 1000);
  if (s <= 0) return 'ora';
  if (s < 3600) return `fra ${Math.round(s / 60)} min`;
  const h = Math.round(s / 3600);
  if (h < 48) return `fra ${h} h`;
  return `fra ${Math.round(h / 24)} giorni`;
}
