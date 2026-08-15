import { useMemo, useRef, useState } from 'react';
import type { Layout, LayoutRow, SensorLast } from '../api/types';
import { FILE_GEOM, crop, rowLength } from '../config/orto';
import { cropGlyph } from '../config/cropGlyphs';
import { ACTIVE_SENSORS, SENSOR_LOCATIONS } from '../config/sensors';
import { humidityColor, type Thresholds } from '../helpers/humidityColor';
import { moistureBands } from '../helpers/moistureBands';
import {
  DESKTOP, MOBILE, clampProbe, flipOffset, glyphTop, labelX, pinY, rowLabelY, rowTop,
  stampY, textW, totalHeight, type OrtoMetrics,
} from '../helpers/ortoMetrics';
import { useMediaQuery } from '../helpers/useMediaQuery';
import { OrtoOverlay } from './OrtoOverlay';
import { fmtRelative } from '../helpers/formatDate';
import { moveDivider, moveSensor } from '../helpers/layoutOps';
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
  /** In editor la mappa diventa interattiva; `layout` e' la bozza. */
  editing?: boolean;
  onChange?: (l: Layout) => void;
}

interface Hover {
  sensor: SensorLast;
  installed: boolean;
  x: number;
  y: number;
}

export function OrtoMap({
  layout, sensors, thresholds, activeSensor, onSelectSensor,
  editing = false, onChange,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const m = useMediaQuery('(min-width: 900px)') ? DESKTOP : MOBILE;

  /** Da coordinate schermo a frazione [0,1] della fila indicata. */
  const frazione = (clientX: number, filaId: number) => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const ctm = svg.getScreenCTM();
    if (!ctm) return 0;
    const p = new DOMPoint(clientX, 0).matrixTransform(ctm.inverse());
    const w = (m.proportional ? rowLength(filaId) : 1) * m.vw;
    return Math.max(0, Math.min(1, p.x / w));
  };

  const byId = useMemo(() => new Map(sensors.map((s) => [s.sensor_id, s])), [sensors]);

  const rows: LayoutRow[] =
    layout?.file ?? FILE_GEOM.map((f) => ({ id: f.id, aree: [], sensori: [] }));

  const totalH = totalHeight(m, rows.length);

  return (
    <div className="orto-map" ref={wrapRef}>
      <svg
        ref={svgRef}
        className={editing ? 'editing' : undefined}
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
            layout={layout}
            byId={byId}
            thresholds={thresholds}
            activeSensor={activeSensor}
            onSelectSensor={onSelectSensor}
            editing={editing}
            frazione={frazione}
            onChange={onChange}
            onHover={(h) => {
              if (editing) return;   // in editor il tooltip darebbe fastidio al drag
              if (!h) return setHover(null);
              const r = wrapRef.current?.getBoundingClientRect();
              if (r) setHover({ ...h, x: h.x - r.left, y: h.y - r.top });
            }}
          />
        ))}
      </svg>

      {editing && layout && onChange && <OrtoOverlay layout={layout} m={m} onChange={onChange} />}
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
  editing: boolean;
  frazione: (clientX: number, filaId: number) => number;
  onChange?: (l: Layout) => void;
  layout?: Layout;
}

function Row({
  row, y, m, byId, thresholds, activeSensor, onSelectSensor, onHover,
  editing, frazione, onChange, layout,
}: RowProps) {
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
          {editing && i < aree.length - 1 && layout && onChange && (
            <rect
              className="orto-handle-div"
              x={a.to * w - 9}
              y={y}
              width={18}
              height={m.rowH}
              onPointerDown={(e) => {
                e.preventDefault();
                (e.target as Element).setPointerCapture(e.pointerId);
                const muovi = (ev: PointerEvent) =>
                  onChange(moveDivider(layout, row.id, i, frazione(ev.clientX, row.id)));
                const su = () => {
                  window.removeEventListener('pointermove', muovi);
                  window.removeEventListener('pointerup', su);
                };
                window.addEventListener('pointermove', muovi);
                window.addEventListener('pointerup', su);
              }}
            />
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
        editing={editing}
        frazione={frazione}
        onChange={onChange}
        layout={layout}
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

function Pins({
  row, w, pinY, m, byId, thresholds, activeSensor, onSelectSensor, onHover,
  editing, frazione, onChange, layout,
}: PinsProps) {
  // Posizionamento prima, collisioni verticali dopo: il lato su cui finisce
  // l'etichetta dipende dal bordo della riga, e va deciso per primo.
  const posate = [...row.sensori]
    .sort((a, b) => a.x - b.x)
    .map((p) => {
      const s = byId.get(p.sensor_id);
      const installed = ACTIVE_SENSORS.has(p.sensor_id);
      const value = installed && s?.value != null ? s.value : null;
      const label = `${p.sensor_id.slice(-2)} · ${value !== null ? `${value.toFixed(0)}%` : 'n.d.'}`;
      const warn = s?.battery_ok === false;
      const testoW = textW(label, m.fsValue);
      const totaleW = testoW + (warn ? m.fsValue * 0.9 : 0);
      const cx = clampProbe(p.x * w, m.probe, w);
      return {
        p, s, installed, warn, label, testoW,
        colore: value !== null && s?.online ? humidityColor(value, thresholds) : 'var(--ink-4)',
        cx,
        x0: labelX(cx, totaleW, w, m.probe * 0.6),
        totaleW,
        flip: false,
      };
    });

  let prevEnd = -Infinity;
  let flip = false;
  for (const it of posate) {
    flip = it.x0 < prevEnd ? !flip : false;
    prevEnd = it.x0 + it.totaleW;
    it.flip = flip;
  }

  return (
    <>
      {posate.map((it) => {
        const cy = pinY + (it.flip ? flipOffset(m) : 0);
        return (
          <g
            key={it.p.sensor_id}
            className={`orto-pin ${activeSensor === it.p.sensor_id ? 'active' : ''}`}
            opacity={it.installed ? 1 : 0.5}
            onMouseEnter={(e) => {
              if (it.s) onHover({ sensor: it.s, installed: it.installed, x: e.clientX, y: e.clientY });
              onSelectSensor(it.p.sensor_id);
            }}
            onMouseLeave={() => {
              onHover(null);
              onSelectSensor(null);
            }}
            onPointerDown={(e) => {
              if (!editing || !layout || !onChange) return;
              e.preventDefault();
              e.stopPropagation();
              (e.target as Element).setPointerCapture(e.pointerId);
              const muovi = (ev: PointerEvent) =>
                onChange(moveSensor(layout, it.p.sensor_id, row.id, frazione(ev.clientX, row.id)));
              const su = () => {
                window.removeEventListener('pointermove', muovi);
                window.removeEventListener('pointerup', su);
              };
              window.addEventListener('pointermove', muovi);
              window.addEventListener('pointerup', su);
            }}
          >
            <g
              className="orto-probe"
              style={{ color: it.colore }}
              transform={`translate(${it.cx - m.probe / 2} ${cy - m.probe / 2}) scale(${m.probe / 24})`}
              dangerouslySetInnerHTML={{ __html: PROBE }}
            />
            <text className="orto-pin-label" x={it.x0} y={cy + m.fsValue * 0.36} fontSize={m.fsValue}>
              {it.label}
            </text>
            {it.warn && (
              <text
                className="orto-warn"
                x={it.x0 + it.testoW + 2}
                y={cy + m.fsValue * 0.36}
                fontSize={m.fsValue}
              >
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
