import type { WeatherDay, WeatherForecastV2, WeatherNowV2 } from '../api/types';
import { fmtTime, DOWS_IT } from '../helpers/formatDate';
import { degToCompass } from '../helpers/wind';

interface Props {
  now: WeatherNowV2 | undefined;
  forecast: WeatherForecastV2 | undefined;
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

function freshnessLabel(ageSeconds: number, stale: boolean): string {
  const m = Math.max(0, Math.floor(ageSeconds / 60));
  if (stale) return m > 0 ? `dati cached · ${m}m fa` : 'dati cached';
  if (m < 2) return 'aggiornata · ora';
  return `aggiornata · ${m}m fa`;
}

function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(digits);
}

export function WeatherCard({ now, forecast, loading }: Props) {
  if (loading || !now || !forecast) {
    return <div style={{ color: 'var(--ink-3)', padding: 16, fontFamily: 'var(--mono)' }}>caricamento meteo…</div>;
  }
  const days: WeatherDay[] = forecast.days ?? [];
  const today = now.today;
  const temp = now.temperature_c;
  const intPart = temp !== null ? Math.floor(temp) : 0;
  const decPart = temp !== null ? Math.abs(Math.round((temp - intPart) * 10)) : 0;
  const isStale = now.stale === true;
  const fresh = freshnessLabel(now.age_seconds ?? 0, isStale);
  const compass = degToCompass(now.wind_direction_deg);

  return (
    <div className="weather">
      <div className="now-temp">
        <div className="weather-head">
          <span className="eyebrow">temperatura · open-meteo</span>
          <span className={`weather-fresh${isStale ? ' is-stale' : ''}`}>{fresh}</span>
        </div>
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
        {now.apparent_temperature_c !== null && (
          <span className="weather-apparent">percepita {fmtNum(now.apparent_temperature_c, 1)}°C</span>
        )}
        <div className="kv weather-kv">
          <span>min / max oggi</span>
          <span className="v">
            {today.t_min !== null ? `${Math.round(today.t_min)}°` : '—'} / {today.t_max !== null ? `${Math.round(today.t_max)}°` : '—'}
          </span>
          <span>umidità aria</span>
          <span className="v">{now.humidity_pct !== null ? `${Math.round(now.humidity_pct)}%` : '—'}</span>
          <span>vento</span>
          <span className="v">
            {now.wind_speed_kmh !== null ? `${fmtNum(now.wind_speed_kmh, 1)} km/h` : '—'}
            {now.wind_direction_deg !== null && <span className="wind-compass"> · {compass}</span>}
          </span>
          <span>pioggia ultima ora</span>
          <span className="v">{now.precipitation_mm_last_hour !== null ? `${fmtNum(now.precipitation_mm_last_hour, 1)} mm` : '—'}</span>
          <span>pioggia 24h</span>
          <span className="v">{today.precip_sum_mm !== null ? `${fmtNum(today.precip_sum_mm, 1)} mm` : '—'}</span>
          <span>prob. pioggia</span>
          <span className="v">{today.precip_probability_pct !== null ? `${Math.round(today.precip_probability_pct)}%` : '—'}</span>
          <span>alba / tramonto</span>
          <span className="v">
            {fmtTime(today.sunrise)} / {fmtTime(today.sunset)}
          </span>
        </div>
      </div>
      <div className="forecast">
        {days.slice(0, 7).map((d, i) => (
          <div key={d.date} className="day">
            <span className="dow">{dowFromIso(d.date, i)}</span>
            <span className="icon">{weatherIcon(d.weather_code)}</span>
            <span className="max tabular">{d.t_max !== null ? `${Math.round(d.t_max)}°` : '—'}</span>
            <span className="min tabular">{d.t_min !== null ? `${Math.round(d.t_min)}°` : '—'}</span>
            {d.precip_probability_pct !== null && d.precip_probability_pct > 0 && (
              <span className="precip-prob tabular">{Math.round(d.precip_probability_pct)}%</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
