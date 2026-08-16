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

// Contaminazione realistica: dopo la chiusura il terreno non fa un gradino,
// sale per un paio di campioni (la redistribuzione dell acqua) e poi scende
// ripida per una dozzina di campioni, a un ritmo multiplo di quello normale
// (l acqua in eccesso che drena), prima di tornare al ritmo regolare. Sono
// proprio le discese ripide il motivo per cui la finestra va esclusa: non
// sono asciugatura, e se restano nel campione gonfiano la stima invece di
// deprimerla.
function contaminaFinestra(serie, inizio, caloPer15min = 0.125) {
  const v = serie.map((p) => ({ ...p }));
  let livello = v[inizio]._value;
  const risalita = 2, ampiezzaRisalita = 1.5;
  const discesaRipida = 12, moltiplicatore = 5;
  for (let k = 0; k < risalita; k++) { livello += ampiezzaRisalita; v[inizio + k]._value = livello; }
  for (let k = 0; k < discesaRipida; k++) { livello -= caloPer15min * moltiplicatore; v[inizio + risalita + k]._value = livello; }
  for (let i = inizio + risalita + discesaRipida; i < v.length; i++) { livello -= caloPer15min; v[i]._value = livello; }
  return v;
}

await t('le finestre sporcate da irrigazione sono escluse', async () => {
  const base = serieInCalo();
  const inizio = Math.floor(base.length / 2);
  const serie = contaminaFinestra(base, inizio);
  const chiusura = new Date(serie[inizio]._time).toISOString();
  const h = banco({ tmp_moisture_series: serie });
  await statistiche({ payload: [{ _time: chiusura, _value: 900 }] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.ok(s, 'drying_stats non scritte');

  // 1) la velocita e soprattutto il p90 restano vicini al valore vero: la
  // dozzina di campioni ripidi (2.5 %/h contro 0.5 %/h) e' circa il 13% del
  // totale, abbastanza da finire proprio nella coda alta se non esclusa.
  assert.ok(Math.abs(s.rate_pct_h - 0.5) < 0.15, `l irrigazione ha inquinato la mediana: ${s.rate_pct_h}`);
  assert.ok(Math.abs(s.p90 - 0.5) < 0.3, `l irrigazione ha inquinato il p90 (le discese ripide non sono state escluse): ${s.p90}`);

  // 2) il numero di campioni puliti e' diminuito rispetto allo stesso
  // scenario senza contaminazione: non lo si deduce da una statistica, lo
  // si conta.
  const pulito = banco({ tmp_moisture_series: base });
  await statistiche({ payload: [] }, pulito.node, pulito.global, pulito.env, pulito.fs);
  assert.ok(s.samples < pulito.store.drying_stats.samples,
    `la finestra contaminata non ha escluso nulla: ${s.samples} campioni contro ${pulito.store.drying_stats.samples} puliti`);
});

await t('serie troppo corta: nessuna statistica, nessun crash', async () => {
  const h = banco({ tmp_moisture_series: serieInCalo(1) });
  await statistiche({ payload: [] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.ok(s === undefined || s.samples < 10, 'con pochi dati non deve pubblicare una stima');
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
