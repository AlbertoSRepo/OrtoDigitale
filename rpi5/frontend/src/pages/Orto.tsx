import { useState } from 'react';
import { useStore } from '../state/store';
import { useSensorsLast, useSensorsTrend } from '../api/sensors';
import { useLayout } from '../api/layout';
import { useWeatherForecast, useWeatherNow } from '../api/weather';
import { OrtoEditor } from '../components/OrtoEditor';
import { HumidityChart } from '../components/HumidityChart';
import { WeatherCard } from '../components/WeatherCard';
import { DateRangePicker } from '../components/DateRangePicker';
import { DEFAULT_THRESHOLDS } from '../helpers/humidityColor';

export function Orto() {
  const period = useStore((s) => s.periodOrto);
  const setPeriod = useStore((s) => s.setPeriodOrto);
  const [active, setActive] = useState<string | null>(null);

  const sensorsQ = useSensorsLast();
  const layoutQ = useLayout();
  const trendQ = useSensorsTrend(period);
  const nowQ = useWeatherNow();
  const forecastQ = useWeatherForecast();

  const sensors = sensorsQ.data ?? [];
  // Un sensore non registrato non ha dati: filtrare sul valore basta (step 14, D8).
  const installed = sensors.filter((s) => s.value !== null);
  const avg = installed.length ? installed.reduce((a, s) => a + (s.value ?? 0), 0) / installed.length : null;
  const thresholds = DEFAULT_THRESHOLDS;

  return (
    <div className="tab-panel">
      <section className="grid" style={{ marginBottom: 18 }}>
        <div className="span-12">
          <OrtoEditor
            layout={layoutQ.data}
            sensors={sensors}
            thresholds={thresholds}
            activeSensor={active}
            onSelectSensor={setActive}
          />
        </div>
      </section>

      <section className="grid" style={{ marginBottom: 18 }}>
        <div className="card span-12 orto-humidity">
          <div className="card-head">
            <h3>Umidità del terreno</h3>
            <DateRangePicker value={period} onChange={setPeriod} />
          </div>
          <div className="kv" style={{ maxWidth: 380, marginBottom: 8 }}>
            <span>fascia di comfort</span>
            <span className="v">
              {thresholds.dry}% – {thresholds.wet}%
            </span>
            <span>media corrente</span>
            <span className="v">{avg !== null ? `${avg.toFixed(1)}%` : '—'}</span>
          </div>
          <HumidityChart trend={trendQ.data} thresholds={thresholds} loading={trendQ.isLoading} />
        </div>
      </section>

      <section className="grid">
        <div className="card span-12">
          <div className="card-head">
            <h3>Meteo locale</h3>
            <span className="eyebrow">7 giorni · open-meteo</span>
          </div>
          <WeatherCard
            now={nowQ.data}
            forecast={forecastQ.data}
            loading={nowQ.isLoading || forecastQ.isLoading}
          />
        </div>
      </section>
    </div>
  );
}
