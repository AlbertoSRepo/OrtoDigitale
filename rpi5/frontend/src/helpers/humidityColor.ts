export interface Thresholds {
  dry: number;
  wet: number;
}

function hex2rgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function rgb2hex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

export function mix(a: string, b: string, t: number): string {
  const A = hex2rgb(a);
  const B = hex2rgb(b);
  return rgb2hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function humidityColor(value: number | null | undefined, thresholds: Thresholds): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return readVar('--ink-4', '#666');
  }
  const cDry = readVar('--hm-dry', '#c2492a');
  const cMid = readVar('--hm-mid', '#8aab5e');
  const cWet = readVar('--hm-wet', '#4690b3');
  const dry = thresholds.dry;
  const wet = thresholds.wet;
  if (value <= dry) {
    const t = Math.max(0, Math.min(1, value / dry));
    return mix(cDry, cMid, t * 0.7);
  }
  if (value >= wet) {
    const t = Math.max(0, Math.min(1, (value - wet) / (100 - wet)));
    return mix(cMid, cWet, 0.3 + t * 0.7);
  }
  const t = (value - dry) / (wet - dry);
  return mix(cMid, t < 0.5 ? cDry : cWet, Math.abs(t - 0.5) * 0.4);
}

export const DEFAULT_THRESHOLDS: Thresholds = { dry: 40, wet: 65 };
