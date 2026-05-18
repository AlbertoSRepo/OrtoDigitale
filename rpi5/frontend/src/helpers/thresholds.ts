export type StatKind = 'disk' | 'cpu' | 'ram';
export type StatColor = 'green' | 'yellow' | 'red';

const THRESHOLDS: Record<StatKind, { yellow: number; red: number }> = {
  disk: { yellow: 70, red: 85 },
  cpu: { yellow: 70, red: 90 },
  ram: { yellow: 75, red: 90 },
};

export function colorForPct(value: number, kind: StatKind): StatColor {
  const t = THRESHOLDS[kind];
  if (value >= t.red) return 'red';
  if (value >= t.yellow) return 'yellow';
  return 'green';
}
