import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SensorTrend } from '../api/types';
import { ACTIVE_SENSORS } from '../config/sensors';
import { humidityColor, type Thresholds } from '../helpers/humidityColor';
import { fmtDateTime } from '../helpers/formatDate';

interface Props {
  trend: SensorTrend | undefined;
  thresholds: Thresholds;
  loading?: boolean;
}

const SENSOR_ORDER = ['WH51_01', 'WH51_02', 'WH51_03', 'WH51_04', 'WH51_05', 'WH51_06'];

function buildMergedSeries(trend: SensorTrend) {
  const tsSet = new Set<number>();
  for (const id of SENSOR_ORDER) {
    const series = trend[id];
    if (!series) continue;
    for (const p of series) tsSet.add(p.t);
  }
  const tsList = Array.from(tsSet).sort((a, b) => a - b);
  const lookup: Record<string, Map<number, number>> = {};
  for (const id of SENSOR_ORDER) {
    lookup[id] = new Map();
    const series = trend[id];
    if (!series) continue;
    for (const p of series) lookup[id].set(p.t, p.value);
  }
  return tsList.map((t) => {
    const row: Record<string, number | null | string> = { t };
    for (const id of SENSOR_ORDER) {
      const v = lookup[id].get(t);
      row[id] = v === undefined ? null : v;
    }
    return row;
  });
}

export function HumidityChart({ trend, thresholds, loading }: Props) {
  const data = useMemo(() => (trend ? buildMergedSeries(trend) : []), [trend]);
  const colors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const id of SENSOR_ORDER) {
      const series = trend?.[id];
      const last = series && series.length ? series[series.length - 1].value : 50;
      out[id] = humidityColor(last, thresholds);
    }
    return out;
  }, [trend, thresholds]);

  if (loading && !data.length) {
    return <div className="chart" style={{ display: 'grid', placeItems: 'center', color: 'var(--ink-3)' }}>caricamento…</div>;
  }
  if (!data.length) {
    return <div className="chart" style={{ display: 'grid', placeItems: 'center', color: 'var(--ink-3)' }}>nessun dato per il periodo</div>;
  }

  return (
    <div className="chart" style={{ height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 18, left: -10, bottom: 4 }}>
          <CartesianGrid stroke="var(--rule-2)" strokeDasharray="2 3" />
          <ReferenceArea
            y1={thresholds.dry}
            y2={thresholds.wet}
            fill="var(--moss)"
            fillOpacity={0.07}
            stroke="none"
          />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v) => fmtDateTime(v as number)}
            stroke="var(--rule)"
            tick={{ fill: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 10 }}
            minTickGap={48}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            stroke="var(--rule)"
            tick={{ fill: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 10 }}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: 'rgba(20, 19, 15, 0.92)',
              border: '0.5px solid rgba(255,255,255,0.18)',
              borderRadius: 0,
              color: '#fbf6ea',
              fontFamily: 'var(--mono)',
              fontSize: 11,
            }}
            labelStyle={{ color: '#fbf6ea', marginBottom: 4 }}
            labelFormatter={(v) => fmtDateTime(v as number)}
            formatter={(value, name) => {
              if (value === null || value === undefined) return ['—', String(name)];
              const num = typeof value === 'number' ? value : Number(value);
              return [Number.isFinite(num) ? `${num.toFixed(1)}%` : '—', String(name)];
            }}
          />
          {SENSOR_ORDER.map((id, idx) => {
            if (!ACTIVE_SENSORS.has(id)) return null;
            return (
              <Line
                key={id}
                type="monotone"
                dataKey={id}
                name={String(idx + 1).padStart(2, '0')}
                stroke={colors[id]}
                strokeWidth={1.4}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
