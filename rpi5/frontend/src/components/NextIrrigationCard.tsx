import type { IrrigationForecast } from '../api/types';
import { fmtFraQuanto } from '../helpers/formatDuration';
import { fmtRelative } from '../helpers/formatDate';

interface Props {
  forecast: IrrigationForecast | undefined;
  loading?: boolean;
}

// Copre l'intera catena decisionale (rpi5/nodered/data/flows.json, nodo
// nf-fn-regole): out_of_window, cooldown, moisture_sufficient, rain_delay,
// no_quorum, valve_unreachable, paused.
const REGOLE: Record<string, string> = {
  out_of_window: 'attende la finestra oraria',
  cooldown: 'attende la fine del cooldown',
  moisture_sufficient: 'attende che il terreno si asciughi',
  rain_delay: 'attende che passi la pioggia prevista',
  no_quorum: 'sonde insufficienti',
  valve_unreachable: 'valvola non raggiungibile',
  paused: 'sistema in pausa',
};

// Copre tutti i valori ammessi per no_irrigation_reason (docs/step15, §7):
// moisture_sufficient, rain_forecast, paused, no_quorum, cooldown, out_of_window.
const NIENTE: Record<string, string> = {
  moisture_sufficient: 'Il terreno resta sopra soglia',
  rain_forecast: 'Pioggia prevista nei prossimi giorni',
  paused: 'Sistema in pausa',
  no_quorum: 'Sonde insufficienti per decidere',
  cooldown: "In cooldown dopo l'ultima irrigazione",
  out_of_window: 'Fuori dalle finestre orarie di apertura',
};

// La previsione si ricalcola ogni 5 min lato server (recompute_interval_seconds).
// Oltre 3 cicli mancati è più probabile che il dato arrivi dalla cache offline
// della PWA che da un calcolo corrente: va dichiarato, mai spacciato per fresco.
const PREVISIONE_STANTIA_MS = 15 * 60_000;

function orario(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export function NextIrrigationCard({ forecast, loading }: Props) {
  if (loading || !forecast) {
    return (
      <div className="card span-12">
        <div className="card-head"><h3>Prossima irrigazione</h3></div>
        <div className="metric" style={{ padding: '8px 0' }}><span className="num">…</span></div>
      </div>
    );
  }

  const n = forecast.next_irrigation;
  const pallini = '●'.repeat(forecast.confidence.level) + '○'.repeat(4 - forecast.confidence.level);

  // generated_at, non age_seconds/stale: questo endpoint (a differenza di
  // weather/system) non li espone, quindi la freschezza si deriva qui — la
  // PWA può servire questa risposta dalla cache offline, e generated_at è
  // l'unico modo per accorgersene invece di mostrare una stima muta.
  const generatedMs = Date.parse(forecast.generated_at);
  const haGeneratedAt = Number.isFinite(generatedMs);
  const isStale = haGeneratedAt && Date.now() - generatedMs > PREVISIONE_STANTIA_MS;
  const freschezza = haGeneratedAt ? fmtRelative(generatedMs) : '—';

  return (
    <div className="card span-12">
      <div className="card-head">
        <h3>Prossima irrigazione</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span className="eyebrow">{forecast.mode === 'auto' ? 'stima' : `modo ${forecast.mode}`}</span>
          <span className={`weather-fresh${isStale ? ' is-stale' : ''}`}>
            {isStale ? `dati non aggiornati · ${freschezza}` : `calcolata ${freschezza}`}
          </span>
        </div>
      </div>

      {n ? (
        <>
          <div className="metric" style={{ padding: '8px 0' }}>
            <span className="num">{orario(n.predicted_at)}</span>
            <span className="lbl">{fmtFraQuanto(n.predicted_at)}</span>
          </div>
          <p style={{ margin: '4px 0', opacity: 0.8 }}>
            fra {orario(n.band_start)} e {n.band_end_open ? 'oltre 3 giorni' : orario(n.band_end)}
          </p>
          <p style={{ margin: '4px 0' }}>
            <span title={forecast.confidence.reasons.join(' · ')}>{pallini}</span>{' '}
            {forecast.confidence.level >= 3 ? 'stima attendibile' : 'stima indicativa'}
          </p>
          <p style={{ margin: '4px 0', opacity: 0.8 }}>
            Apertura prevista ~{Math.round(n.expected_duration_seconds / 60)} min
            {n.limiting_rule ? ` · ${REGOLE[n.limiting_rule] ?? n.limiting_rule}` : ''}
          </p>
        </>
      ) : (
        <>
          <div className="metric" style={{ padding: '8px 0' }}>
            <span className="num">Non prevista</span>
            <span className="lbl">nei prossimi 3 giorni</span>
          </div>
          <p style={{ margin: '4px 0', opacity: 0.8 }}>
            {NIENTE[forecast.no_irrigation_reason ?? ''] ?? 'Nessuna condizione di apertura'}
          </p>
        </>
      )}

      <p style={{ margin: '8px 0 0', opacity: 0.7, fontSize: '0.85em' }}>
        Umidità {forecast.current.moisture_mean ?? '—'}% · cala ~{forecast.current.drying_rate_pct_h} %/h
        {forecast.model.method === 'empirical' && ' · stima senza meteo'}
      </p>
    </div>
  );
}
