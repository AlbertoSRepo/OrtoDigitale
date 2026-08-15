import { useMemo, useRef, useState } from 'react';
import type { Layout, LayoutRow, SensorLast } from '../api/types';
import { FILE_GEOM, crop, cropGlyph, rowLength } from '../config/orto';
import { ACTIVE_SENSORS, SENSOR_LOCATIONS } from '../config/sensors';
import { humidityColor, type Thresholds } from '../helpers/humidityColor';
import { moistureBands } from '../helpers/moistureBands';
import {
  DESKTOP, MOBILE, flipOffset, glyphTop, pinY, rowLabelY, rowTop, stampY, textW, totalHeight,
  type OrtoMetrics,
} from '../helpers/ortoMetrics';
import { useMediaQuery } from '../helpers/useMediaQuery';
import { fmtRelative } from '../helpers/formatDate';
import probeSvg from '../assets/sensor.svg?raw';

/** Il glifo sonda è vettoriale e monocromatico: si tinge col colore dell'umidità.
 *  Il wrapper <svg> va tolto una volta sola, qui. */
const PROBE = probeSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

interface Props {
  layout: Layout | undefined;
  sensors: SensorLast[];
  thresholds: Thresholds;
  activeSensor: string | null;
  onSelectSensor: (id: string | null) => void;
}

interface Hover {
  sensor: SensorLast;
  installed: boolean;
  x: number;
  y: number;
}

export function OrtoMap({ layout, sensors, thresholds, activeSensor, onSelectSensor }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const m = useMediaQuery('(min-width: 900px)') ? DESKTOP : MOBILE;

  const byId = useMemo(() => new Map(sensors.map((s) => [s.sensor_id, s])), [sensors]);

  const rows: LayoutRow[] =
    layout?.file ?? FILE_GEOM.map((f) => ({ id: f.id, aree: [], sensori: [] }));

  const totalH = totalHeight(m, rows.length);

  return (
    <div className="orto-map" ref={wrapRef}>
      <svg
        viewBox={`${-m.pad} 0 ${m.vw + m.pad * 2} ${totalH}`}
        role="img"
        aria-label="Mappa dell'orto"
      >
        <defs>
          <pattern id="orto-nodata" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--ink-4)" strokeWidth="1.5" opacity="0.35" />
          </pattern>
        </defs>

        {rows.map((row, i) => (
          <Row
            key={row.id}
            row={row}
            y={rowTop(m, i)}
            m={m}
            byId={byId}
            thresholds={thresholds}
            activeSensor={activeSensor}
            onSelectSensor={onSelectSensor}
            onHover={(h) => {
              if (!h) return setHover(null);
              const r = wrapRef.current?.getBoundingClientRect();
              if (r) setHover({ ...h, x: h.x - r.left, y: h.y - r.top });
            }}
          />
        ))}
      </svg>

      {hover && <SensorTooltip hover={hover} />}
    </div>
  );
}

interface RowProps {
  row: LayoutRow;
  y: number;
  m: OrtoMetrics;
  byId: Map<string, SensorLast>;
  thresholds: Thresholds;
  activeSensor: string | null;
  onSelectSensor: (id: string | null) => void;
  onHover: (h: { sensor: SensorLast; installed: boolean; x: number; y: number } | null) => void;
}

function Row({ row, y, m, byId, thresholds, activeSensor, onSelectSensor, onHover }: RowProps) {
  const w = (m.proportional ? rowLength(row.id) : 1) * m.vw;
  const bands = moistureBands(row.sensori);

  const readings = row.sensori
    .map((s) => byId.get(s.sensor_id))
    .filter((s): s is SensorLast => !!s && ACTIVE_SENSORS.has(s.sensor_id) && s.value !== null);
  const media = readings.length
    ? readings.reduce((a, s) => a + (s.value ?? 0), 0) / readings.length
    : null;

  // Aree: il bordo sinistro è il `to` della precedente (step 12, §5.2).
  let from = 0;
  const aree = row.aree.map((a) => {
    const seg = { ...a, from, to: a.to };
    from = a.to;
    return seg;
  });

  return (
    <g>
      <text className="orto-row-label" x={0} y={rowLabelY(m, y)} fontSize={m.fsLabel}>
        fila {row.id}
        <tspan className="media" dx={12}>
          {media !== null ? `media ${media.toFixed(0)}%` : 'nessun dato'}
        </tspan>
      </text>

      <rect className="orto-soil" x={0} y={y} width={w} height={m.rowH} />

      {/* 2 — zone umidità, derivate dai pin */}
      {bands.length === 0 ? (
        <rect x={0} y={y} width={w} height={m.rowH} fill="url(#orto-nodata)" />
      ) : (
        bands.map((b) => {
          const s = byId.get(b.sensor_id);
          const usable = s && ACTIVE_SENSORS.has(b.sensor_id) && s.online && s.value !== null;
          return (
            <rect
              key={b.sensor_id}
              x={b.from * w}
              y={y}
              width={(b.to - b.from) * w}
              height={m.rowH}
              fill={usable ? humidityColor(s.value, thresholds) : 'url(#orto-nodata)'}
              opacity={usable ? 0.55 : 1}
            />
          );
        })
      )}

      {/* 3 — aree coltura: divisori + un timbro per area */}
      {aree.map((a, i) => (
        <g key={i}>
          {i < aree.length - 1 && (
            <line className="orto-divider" x1={a.to * w} y1={y} x2={a.to * w} y2={y + m.rowH} />
          )}
          <CropStamp
            area={a}
            cx={((a.from + a.to) / 2) * w}
            baseline={stampY(m, y)}
            px={(a.to - a.from) * w}
            m={m}
          />
        </g>
      ))}

      <rect className="orto-row-edge" x={0} y={y} width={w} height={m.rowH} />

      {/* 5 — sonde: glifo tinto + etichetta con alone */}
      <Pins
        row={row}
        w={w}
        pinY={pinY(m, y)}
        m={m}
        byId={byId}
        thresholds={thresholds}
        activeSensor={activeSensor}
        onSelectSensor={onSelectSensor}
        onHover={onHover}
      />
    </g>
  );
}

type PinsProps = Omit<RowProps, 'y'> & { w: number; pinY: number };

function Pins({ row, w, pinY, m, byId, thresholds, activeSensor, onSelectSensor, onHover }: PinsProps) {
  const sorted = [...row.sensori].sort((a, b) => a.x - b.x);
  let prevEnd = -Infinity;
  let flip = false;

  return (
    <>
      {sorted.map((p) => {
        const s = byId.get(p.sensor_id);
        const installed = ACTIVE_SENSORS.has(p.sensor_id);
        const value = installed && s?.value != null ? s.value : null;
        const c = value !== null && s?.online ? humidityColor(value, thresholds) : 'var(--ink-4)';
        const num = p.sensor_id.slice(-2);
        const label = `${num} · ${value !== null ? `${value.toFixed(0)}%` : 'n.d.'}`;

        const cx = p.x * w;
        const start = cx + m.probe * 0.6;
        // Sfalsa verticalmente solo se l'etichetta precedente arriverebbe addosso.
        flip = start < prevEnd ? !flip : false;
        prevEnd = start + textW(label, m.fsValue);
        const cy = pinY + (flip ? flipOffset(m) : 0);

        return (
          <g
            key={p.sensor_id}
            className={`orto-pin ${activeSensor === p.sensor_id ? 'active' : ''}`}
            opacity={installed ? 1 : 0.5}
            onMouseEnter={(e) => {
              if (s) onHover({ sensor: s, installed, x: e.clientX, y: e.clientY });
              onSelectSensor(p.sensor_id);
            }}
            onMouseLeave={() => {
              onHover(null);
              onSelectSensor(null);
            }}
          >
            <g
              className="orto-probe"
              style={{ color: c }}
              transform={`translate(${cx - m.probe / 2} ${cy - m.probe / 2}) scale(${m.probe / 24})`}
              dangerouslySetInnerHTML={{ __html: PROBE }}
            />
            <text className="orto-pin-label" x={start} y={cy + m.fsValue * 0.36} fontSize={m.fsValue}>
              {label}
            </text>
            {s?.battery_ok === false && (
              <text className="orto-warn" x={prevEnd + 4} y={cy + m.fsValue * 0.36} fontSize={m.fsValue}>
                ⚠
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

function CropStamp({
  area, cx, baseline, px, m,
}: { area: { crop: string; n: number }; cx: number; baseline: number; px: number; m: OrtoMetrics }) {
  const c = crop(area.crop);
  if (c.color === null) return null; // `libero`: terreno nudo, nessun timbro

  const url = cropGlyph(area.crop);
  const count = `×${area.n}`;
  const full = `${c.label} ${count}`;

  // Degradazione per larghezza resa (step 12, §7.2): componenti che cadono uno
  // alla volta, non glifi che si affollano. Le soglie stanno nelle metriche,
  // così su mobile resta il solo glifo senza un ramo dedicato qui.
  const showLabel = px >= m.labelMinPx;
  const showCount = px >= m.countMinPx;
  if (px < m.glyphMinPx) return null;

  const txt = showLabel ? full : showCount ? count : '';
  const tw = textW(txt, m.fsSmall);
  const gw = url ? m.glyph : 0;
  const gapX = url && txt ? 8 : 0;
  const x0 = cx - (gw + gapX + tw) / 2;

  return (
    <g className="orto-stamp" style={{ color: c.color }}>
      {url && (
        <image
          href={url}
          x={x0}
          y={glyphTop(m, baseline)}
          width={m.glyph}
          height={m.glyph}
          preserveAspectRatio="xMidYMid meet"
        />
      )}
      {txt && (
        <text x={x0 + gw + gapX} y={baseline} fontSize={m.fsSmall}>
          {txt}
        </text>
      )}
    </g>
  );
}

function SensorTooltip({ hover }: { hover: Hover }) {
  const s = hover.sensor;
  const loc = SENSOR_LOCATIONS[s.sensor_id];
  const aiuola = s.aiuola ?? loc?.aiuola ?? '—';
  const position = s.position ?? loc?.position ?? '—';
  return (
    <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h4>
          aiuola {aiuola} · {position}
        </h4>
        <span className="mono" style={{ fontSize: 10, opacity: 0.6 }}>
          {s.sensor_id}
        </span>
      </div>
      {!hover.installed ? (
        <span className="v" style={{ fontSize: 14 }}>
          sensore non installato
        </span>
      ) : (
        <dl>
          <dt>batteria</dt>
          <dd>{s.battery_ok === null ? '—' : s.battery_ok ? 'ok' : 'scarica'}</dd>
          <dt>rssi</dt>
          <dd>{s.rssi ?? '—'} dBm</dd>
          <dt>letta</dt>
          <dd>{s.timestamp ? fmtRelative(s.timestamp) : '—'}</dd>
        </dl>
      )}
    </div>
  );
}
