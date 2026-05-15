import { useRef, useState } from 'react';
import type { SensorLast } from '../api/types';
import { ACTIVE_SENSORS, AIUOLE, SENSOR_COORDS, SENSOR_LOCATIONS } from '../config/sensors';
import { humidityColor, type Thresholds } from '../helpers/humidityColor';
import { fmtRelative } from '../helpers/formatDate';

interface Props {
  sensors: SensorLast[];
  thresholds: Thresholds;
  showAiuole?: boolean;
  activeSensor: string | null;
  onSelectSensor: (id: string | null) => void;
}

interface Hover {
  sensor: SensorLast;
  installed: boolean;
  x: number;
  y: number;
}

export function Hero({ sensors, thresholds, showAiuole = true, activeSensor, onSelectSensor }: Props) {
  const photoRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  return (
    <div className="hero">
      <div ref={photoRef} className="photo" style={{ backgroundImage: "url('/ortophoto.jpg')" }}>
        <div className="hero-legend">
          <span>secco</span>
          <span className="bar" />
          <span>bagnato</span>
          <span className="nums tabular">
            <span>{thresholds.dry}%</span>
            <span>·</span>
            <span>{thresholds.wet}%</span>
          </span>
        </div>

        {showAiuole &&
          AIUOLE.map((a) => (
            <div
              key={a.id}
              className="aiuola-guide"
              style={{
                left: `${a.x * 100}%`,
                top: `${a.y * 100}%`,
                width: `${a.w * 100}%`,
                height: `${a.h * 100}%`,
              }}
            >
              <span className="lbl">aiuola {String(a.id).padStart(2, '0')}</span>
            </div>
          ))}

        <div className="heatmap-blobs">
          {sensors.map((s) => {
            const coord = SENSOR_COORDS[s.sensor_id];
            if (!coord || !ACTIVE_SENSORS.has(s.sensor_id) || s.value === null) return null;
            return (
              <div
                key={s.sensor_id}
                className="blob"
                style={{
                  left: `${coord.x * 100}%`,
                  top: `${coord.y * 100}%`,
                  background: humidityColor(s.value, thresholds),
                }}
              />
            );
          })}
        </div>

        {sensors.map((s, idx) => {
          const coord = SENSOR_COORDS[s.sensor_id];
          if (!coord) return null;
          const installed = ACTIVE_SENSORS.has(s.sensor_id);
          const c = installed && s.value !== null ? humidityColor(s.value, thresholds) : '#888';
          const isActive = activeSensor === s.sensor_id;
          const isOnline = installed && s.online;
          return (
            <div
              key={s.sensor_id}
              className={`pin ${isOnline ? 'online' : ''} ${isActive ? 'active' : ''}`}
              style={{ left: `${coord.x * 100}%`, top: `${coord.y * 100}%`, opacity: installed ? 1 : 0.55 }}
              onMouseEnter={(e) => {
                const r = photoRef.current?.getBoundingClientRect();
                if (!r) return;
                setHover({ sensor: s, installed, x: e.clientX - r.left, y: e.clientY - r.top });
                onSelectSensor(s.sensor_id);
              }}
              onMouseMove={(e) => {
                const r = photoRef.current?.getBoundingClientRect();
                if (!r) return;
                setHover({ sensor: s, installed, x: e.clientX - r.left, y: e.clientY - r.top });
              }}
              onMouseLeave={() => {
                setHover(null);
                onSelectSensor(null);
              }}
              onClick={() => onSelectSensor(s.sensor_id)}
            >
              <span className="halo" style={{ background: c }} />
              <span className="ring" />
              <span className="dot" style={{ background: c }}>
                {String(idx + 1).padStart(2, '0')}
              </span>
            </div>
          );
        })}

        {hover && <SensorTooltip hover={hover} />}
      </div>
    </div>
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
        <>
          <span className="v">
            {s.value !== null ? s.value.toFixed(1) : '—'}
            <span style={{ fontSize: 13, opacity: 0.6 }}> %</span>
          </span>
          <dl>
            <dt>online</dt>
            <dd>{s.online ? 'sì' : 'no'}</dd>
            <dt>batteria</dt>
            <dd>{s.battery_ok === null ? '—' : s.battery_ok ? 'ok' : 'scarica'}</dd>
            <dt>rssi</dt>
            <dd>{s.rssi ?? '—'} dBm</dd>
            <dt>letta</dt>
            <dd>{s.timestamp ? fmtRelative(s.timestamp) : '—'}</dd>
          </dl>
        </>
      )}
    </div>
  );
}
