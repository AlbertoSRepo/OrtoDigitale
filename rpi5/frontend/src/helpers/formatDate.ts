const MONTHS_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

export function fmtDayShort(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS_IT[d.getMonth()]}`;
}

export function fmtRelative(date: Date | number | null | undefined): string {
  if (!date) return '—';
  const t = typeof date === 'number' ? date : date.getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 0) return 'in arrivo';
  if (s < 60) return s + 's fa';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm fa';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h fa';
  const d = Math.floor(h / 24);
  return d + 'g fa';
}

export function fmtDateTime(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mn = String(date.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mn}`;
}

export function toInputDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function fromInputDate(s: string, endOfDay = false): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
}

export const DOWS_IT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
