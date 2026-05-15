import { useMemo, useRef, useState } from 'react';
import type { ValveInterval } from '../api/types';
import { resolvePeriod, type Period } from '../state/store';
import { fmtDateTime } from '../helpers/formatDate';
import { fmtDurationShort } from '../helpers/formatDuration';

interface Props {
  intervals: ValveInterval[] | undefined;
  period: Period;
  loading?: boolean;
}

interface Segment {
  type: 'auto' | 'manuale' | 'chiuso';
  start: number;
  end: number;
  origEnd?: number | null;
}

function buildSegments(intervals: ValveInterval[], t0: number, t1: number): Segment[] {
  const nowMs = Date.now();
  const opens: Segment[] = intervals
    .map((iv) => ({
      type: iv.trigger === 'manual' ? ('manuale' as const) : ('auto' as const),
      start: Math.max(iv.start, t0),
      end: Math.min(iv.end ?? nowMs, t1),
      origEnd: iv.end,
    }))
    .filter((iv) => iv.end > t0 && iv.start < t1)
    .sort((a, b) => a.start - b.start);

  const periods: Segment[] = [];
  let cursor = t0;
  for (const o of opens) {
    if (o.start > cursor) periods.push({ type: 'chiuso', start: cursor, end: o.start });
    periods.push(o);
    cursor = Math.max(cursor, o.end);
  }
  if (cursor < t1) periods.push({ type: 'chiuso', start: cursor, end: t1 });
  return periods;
}

function colorFor(type: Segment['type']): string {
  if (type === 'manuale') return 'var(--terra-2)';
  if (type === 'auto') return 'var(--water-2)';
  return 'var(--ink-4)';
}

function tickLabel(t: number, span: number): string {
  const d = new Date(t);
  if (span <= 86400000 + 1000) {
    return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
}

export function ValveStepChart({ intervals, period, loading }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ seg: Segment; xPct: number } | null>(null);
  const resolved = useMemo(() => resolvePeriod(period), [period]);

  const segments = useMemo(
    () => (intervals ? buildSegments(intervals, resolved.t0, resolved.t1) : []),
    [intervals, resolved.t0, resolved.t1],
  );

  if (loading && !segments.length) {
    return <div className="chart" style={{ height: 110, display: 'grid', placeItems: 'center', color: 'var(--ink-3)' }}>caricamento…</div>;
  }
  if (!segments.length) {
    return <div className="chart" style={{ height: 110, display: 'grid', placeItems: 'center', color: 'var(--ink-3)' }}>nessun dato per il periodo</div>;
  }

  const W = 720;
  const H = 110;
  const ML = 32;
  const MR = 18;
  const MT = 14;
  const MB = 24;
  const iw = W - ML - MR;
  const ih = H - MT - MB;
  const trackH = 22;
  const yTrack = MT + (ih - trackH) / 2;
  const minBarW = 1.5;
  const xScale = (t: number) => ML + ((t - resolved.t0) / resolved.span) * iw;

  const ticks = Array.from({ length: 5 }, (_, i) => resolved.t0 + (i / 4) * resolved.span);

  const showTip = (seg: Segment) => {
    const midT = (seg.start + seg.end) / 2;
    const xPct = (xScale(midT) / W) * 100;
    setHover({ seg, xPct });
  };

  const nowMs = Date.now();

  return (
    <div
      className="chart valve-chart"
      ref={wrapRef}
      style={{ height: 110, position: 'relative' }}
      onMouseLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <g className="axis">
          {ticks.map((t, i) => (
            <text
              key={i}
              x={xScale(t)}
              y={H - 6}
              textAnchor="middle"
              style={{ font: '9.5px var(--mono)', fill: 'var(--ink-3)' }}
            >
              {tickLabel(t, resolved.span)}
            </text>
          ))}
        </g>
        <text
          x={ML - 10}
          y={yTrack + trackH / 2 + 3}
          textAnchor="end"
          style={{ font: '9.5px var(--mono)', fill: 'var(--ink-3)' }}
        >
          open
        </text>
        <line
          x1={ML}
          x2={ML + iw}
          y1={yTrack + trackH}
          y2={yTrack + trackH}
          stroke="var(--rule)"
          strokeWidth="0.5"
        />
        {segments.map((p, i) => {
          const x1 = xScale(p.start);
          const x2 = xScale(p.end);
          const w = Math.max(minBarW, x2 - x1);
          const isClosed = p.type === 'chiuso';
          const isHover = hover && hover.seg === p;
          return (
            <rect
              key={i}
              x={x1}
              y={yTrack}
              width={w}
              height={trackH}
              fill={colorFor(p.type)}
              opacity={isClosed ? (isHover ? 0.55 : 0.32) : isHover ? 1 : 0.88}
              style={{ cursor: 'pointer', transition: 'opacity 120ms' }}
              onMouseEnter={() => showTip(p)}
              onMouseMove={() => showTip(p)}
            />
          );
        })}
      </svg>

      {hover && (
        <div className="tooltip valve-tip" style={{ left: `${hover.xPct}%`, top: yTrack }}>
          <h4>
            <span
              className="dot"
              style={{
                background: colorFor(hover.seg.type),
                display: 'inline-block',
                width: 8,
                height: 8,
                marginRight: 6,
                verticalAlign: 'middle',
              }}
            />
            {hover.seg.type}
          </h4>
          <span className="v">{fmtDurationShort((hover.seg.end - hover.seg.start) / 1000)}</span>
          <dl>
            <dt>inizio</dt>
            <dd>{fmtDateTime(hover.seg.start)}</dd>
            <dt>fine</dt>
            <dd>
              {hover.seg.type !== 'chiuso' && hover.seg.origEnd === null && hover.seg.end >= nowMs - 1000
                ? 'in corso'
                : fmtDateTime(hover.seg.end)}
            </dd>
          </dl>
        </div>
      )}

      <div className="legend">
        <span>
          <span className="dot" style={{ background: 'var(--water-2)' }} />
          auto
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--terra-2)' }} />
          manuale
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--ink-4)', opacity: 0.6 }} />
          chiuso
        </span>
      </div>
    </div>
  );
}
