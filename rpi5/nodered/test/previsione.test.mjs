// Banco di prova della previsione (step 15, Task 4 e 5).
//
//   node rpi5/nodered/test/previsione.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export function compila(id) {
  const n = flows.find((x) => x.id === id);
  assert.ok(n, `nodo ${id} non trovato in flows.json`);
  return new AsyncFunction('msg', 'node', 'global', 'env', 'fs', n.func);
}

const statistiche = compila('nf-fn-stats');

export const CFG = {
  irrigation: {
    soglia_apertura_pct: 40, soglia_chiusura_pct: 65, soglia_emergenza_pct: 25,
    cooldown_seconds: 7200, safety_timeout_seconds: 900, emergency_duration_seconds: 300,
    finestra_mattina: ['06:00', '08:00'], finestra_sera: ['19:00', '01:00'],
  },
  weather: { cache_max_age_seconds: 5400, rain_threshold_mm: 5, rain_window_hours: 24 },
  valve: { unreachable_alert_after: 3 },
  sensors: { max_age_seconds: 1800, min_quorum: 2, stddev_warning_pct: 25 },
  forecast: {
    enabled: true, horizon_hours: 72, step_minutes: 15,
    recompute_interval_seconds: 300, stats_refresh_interval_seconds: 3600,
    stats_window_days: 7, k_pct_per_mm: null, k_pct_per_mm_p10: null,
    k_pct_per_mm_p90: null, rain_gain_pct_per_mm: 1.2, fallback_drying_rate_pct_h: 0.5,
  },
  mode: 'auto', pause_until: null,
};

export function banco(extra = {}) {
  const store = { irrigation_config: JSON.parse(JSON.stringify(CFG)), ...extra };
  const warns = [];
  return {
    store, warns,
    node: { warn: (m) => warns.push(m), log: () => {}, status: () => {}, error: (m) => warns.push('ERR ' + m) },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: () => undefined },
    fs: {},
  };
}

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

console.log('— statistiche di asciugatura —');

// Serie sintetica: cala 0.5 punti ogni 15 min (= 2 %/h) per 24 ore.
function serieInCalo(oreDaOra = 24, caloPer15min = 0.125) {
  const fine = Date.now();
  const punti = [];
  const n = oreDaOra * 4;
  for (let i = 0; i < n; i++) {
    punti.push({ _time: new Date(fine - (n - i) * 15 * 60000).toISOString(), _value: 60 - i * caloPer15min });
  }
  return punti;
}

await t('da una discesa costante ricava la velocita giusta', async () => {
  const h = banco({ tmp_moisture_series: serieInCalo() });
  await statistiche({ payload: [] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.ok(s, 'drying_stats non scritte');
  assert.ok(Math.abs(s.rate_pct_h - 0.5) < 0.05, `attesa ~0.5 %/h, ottenuta ${s.rate_pct_h}`);
  assert.ok(s.samples > 50);
});

await t('le finestre sporcate da irrigazione sono escluse', async () => {
  const serie = serieInCalo();
  // Salto verso l alto a meta serie: se non fosse escluso, falserebbe la media.
  const meta = Math.floor(serie.length / 2);
  for (let i = meta; i < meta + 12; i++) serie[i]._value += 15;
  const chiusura = new Date(serie[meta]._time).toISOString();
  const h = banco({ tmp_moisture_series: serie });
  await statistiche({ payload: [{ _time: chiusura, _value: 900 }] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.ok(Math.abs(s.rate_pct_h - 0.5) < 0.15, `l irrigazione ha inquinato la stima: ${s.rate_pct_h}`);
});

await t('serie troppo corta: nessuna statistica, nessun crash', async () => {
  const h = banco({ tmp_moisture_series: serieInCalo(1) });
  await statistiche({ payload: [] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.ok(s === undefined || s.samples < 10, 'con pochi dati non deve pubblicare una stima');
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
