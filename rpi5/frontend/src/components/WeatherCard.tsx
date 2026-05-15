import type { WeatherForecastDay, WeatherNow } from '../api/types';
import { fmtRelative, DOWS_IT } from '../helpers/formatDate';

interface Props {
  now: WeatherNow | undefined;
  forecast: WeatherForecastDay[] | undefined;
  loading?: boolean;
}

// WMO weather code → emoji semplice (mapping standard, fonte Open-Meteo docs).
function weatherIcon(code: number | null): string {
  if (code === null) return '·';
  if (code === 0) return '☀';
  if (code <= 2) return '🌤';
  if (code === 3) return '☁';
  if (code === 45 || code === 48) return '🌫';
  if (code >= 51 && code <= 57) return '🌦';
  if (code >= 61 && code <= 67) return '🌧';
  if (code >= 71 && code <= 77) return '❄';
  if (code >= 80 && code <= 82) return '🌧';
  if (code >= 85 && code <= 86) return '🌨';
  if (code >= 95) return '⛈';
  return '·';
}

function dowFromIso(iso: string, idx: number): string {
  if (idx === 0) return 'oggi';
  const d = new Date(iso + 'T00:00:00');
  return DOWS_IT[d.getDay()];
}

export function WeatherCard({ now, forecast, loading }: Props) {
  if (loading || !now || !forecast) {
    return <div style={{ color: 'var(--ink-3)', padding: 16, fontFamily: 'var(--mono)' }}>caricamento meteo…</div>;
  }
  const temp = now.temperature_c ?? forecast[0]?.t_max ?? null;
  const intPart = temp !== null ? Math.floor(temp) : 0;
  const decPart = temp !== null ? Math.abs(Math.round((temp - intPart) * 10)) : 0;
  return (
    <div className="weather">
      <div className="now-temp">
        <span className="eyebrow">temperatura · open-meteo</span>
        <div className="big tabular">
          {temp === null ? (
            '—'
          ) : (
            <>
              {intPart}
              <span style={{ fontSize: 38, color: 'var(--ink-3)' }}>.{decPart}</span>
              <span className="deg">°C</span>
            </>
          )}
        </div>
        <div className="kv" style={{ maxWidth: 280 }}>
          <span>aggiornata</span>
          <span className="v">{now.timestamp ? fmtRelative(now.timestamp) : '—'}</span>
          <span>min / max oggi</span>
          <span className="v">
            {forecast[0]?.t_min ?? '—'}° / {forecast[0]?.t_max ?? '—'}°
          </span>
          {now.precip_next_24h_mm !== null && now.precip_next_24h_mm !== undefined && (
            <>
              <span>pioggia 24h</span>
              <span className="v">{now.precip_next_24h_mm.toFixed(1)} mm</span>
            </>
          )}
        </div>
      </div>
      <div className="forecast">
        {forecast.slice(0, 7).map((d, i) => (
          <div key={d.date} className="day">
            <span className="dow">{dowFromIso(d.date, i)}</span>
            <span className="icon">{weatherIcon(d.weather_code)}</span>
            <span className="max tabular">{d.t_max !== null ? `${Math.round(d.t_max)}°` : '—'}</span>
            <span className="min tabular">{d.t_min !== null ? `${Math.round(d.t_min)}°` : '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
