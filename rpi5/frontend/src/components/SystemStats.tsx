import { useSystemStats } from '../api/system';
import { fmtBytes } from '../helpers/formatBytes';
import { colorForPct } from '../helpers/thresholds';
import type { StatKind } from '../helpers/thresholds';

export function SystemStats() {
  const { data, isLoading, error } = useSystemStats();

  if (isLoading) {
    return <span style={{ color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>…</span>;
  }
  if (error || !data) {
    return <span style={{ color: 'var(--terra)', fontFamily: 'var(--mono)', fontSize: 11 }}>stat non disponibili</span>;
  }

  const stale = data.stale || (data.age_seconds !== null && data.age_seconds > 30);

  return (
    <div className="sys-rows">
      <SysBar
        label="Disco"
        pct={data.disk.used_pct}
        detail={`${fmtBytes(data.disk.used_bytes)} / ${fmtBytes(data.disk.total_bytes)}`}
        kind="disk"
      />
      <SysBar
        label="CPU"
        pct={data.cpu.used_pct}
        detail={`load ${data.cpu.load_avg_1_5_15.map((n) => n.toFixed(2)).join(', ')}`}
        kind="cpu"
      />
      <SysBar
        label="RAM"
        pct={data.ram.used_pct}
        detail={`${fmtBytes(data.ram.used_bytes)} / ${fmtBytes(data.ram.total_bytes)}`}
        kind="ram"
      />
      {data.thermal.soc_temp_c !== null && (
        <div className="sys-temp">
          <span className="sys-label">Temp SoC</span>
          <span className="sys-pct tabular">{data.thermal.soc_temp_c.toFixed(1)} °C</span>
        </div>
      )}
      {stale && (
        <span className="badge-warn">dati di {data.age_seconds ?? '?'}s fa</span>
      )}
    </div>
  );
}

interface SysBarProps {
  label: string;
  pct: number;
  detail: string;
  kind: StatKind;
}

function SysBar({ label, pct, detail, kind }: SysBarProps) {
  const color = colorForPct(pct, kind);
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="sys-row">
      <span className="sys-label">{label}</span>
      <div className="bar">
        <div className={`bar-fill bar-${color}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="sys-pct tabular">{pct.toFixed(1)}%</span>
      <span className="sys-detail">{detail}</span>
    </div>
  );
}
