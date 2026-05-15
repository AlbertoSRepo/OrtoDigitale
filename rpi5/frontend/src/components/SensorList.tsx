import type { SensorLast } from '../api/types';
import { ACTIVE_SENSORS, SENSOR_LOCATIONS } from '../config/sensors';
import { humidityColor, type Thresholds } from '../helpers/humidityColor';

interface Props {
  sensors: SensorLast[];
  thresholds: Thresholds;
  active: string | null;
  onSelect: (id: string | null) => void;
}

const SENSOR_ORDER = ['WH51_01', 'WH51_02', 'WH51_03', 'WH51_04', 'WH51_05', 'WH51_06'];

export function SensorList({ sensors, thresholds, active, onSelect }: Props) {
  const byId = new Map(sensors.map((s) => [s.sensor_id, s]));
  return (
    <div className="sensor-list">
      {SENSOR_ORDER.map((id, i) => {
        const s = byId.get(id);
        const installed = ACTIVE_SENSORS.has(id);
        const loc = SENSOR_LOCATIONS[id];
        const value = s?.value ?? null;
        const c = installed && value !== null ? humidityColor(value, thresholds) : '#888';
        const isActive = active === id;
        const aiuola = s?.aiuola ?? loc?.aiuola ?? '—';
        const position = s?.position ?? loc?.position ?? '—';
        return (
          <div
            key={id}
            className={`row ${isActive ? 'active' : ''}`}
            onMouseEnter={() => onSelect(id)}
            onMouseLeave={() => onSelect(null)}
            style={{ opacity: installed ? 1 : 0.55 }}
          >
            <span className="swatch" style={{ background: c }} />
            <span className="id">
              <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>{String(i + 1).padStart(2, '0')}</span>
              {' · '}
              aiuola {aiuola} · {position}
              {!installed && (
                <span style={{ color: 'var(--ink-3)', marginLeft: 6, fontSize: 10 }}>
                  · non installato
                </span>
              )}
              {installed && s && s.battery_ok === false && (
                <span title="batteria scarica" style={{ color: 'var(--terra)', marginLeft: 6 }}>
                  ⚠
                </span>
              )}
              {installed && s && !s.online && (
                <span title="offline" style={{ color: 'var(--ink-4)', marginLeft: 6, fontSize: 10 }}>
                  · offline
                </span>
              )}
            </span>
            <span className="val">
              {installed && value !== null ? value.toFixed(1) : '—'}
              <span style={{ color: 'var(--ink-3)', fontSize: 10, marginLeft: 2 }}>%</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
