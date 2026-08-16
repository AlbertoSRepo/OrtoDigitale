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

await t('un buco nella serie viene saltato, non mediato', async () => {
  // Scenario di controllo: stessa serie, nessun buco. Serve per sapere quanti
  // campioni ci si aspetta SENZA il salto, e verificare che il buco ne tolga
  // esattamente uno (la coppia a cavallo del salto), non zero.
  const pulito = banco({ tmp_moisture_series: serieInCalo() });
  await statistiche({ payload: [] }, pulito.node, pulito.global, pulito.env, pulito.fs);
  const campioniSenzaBuco = pulito.store.drying_stats.samples;

  const serie = serieInCalo();
  const buco = Math.floor(serie.length / 2);
  const spostamento = 3 * 3600000; // 3h: ben oltre i 30 min che segnano un buco
  for (let i = buco; i < serie.length; i++) {
    serie[i]._time = new Date(new Date(serie[i]._time).getTime() + spostamento).toISOString();
  }
  const h = banco({ tmp_moisture_series: serie });
  await statistiche({ payload: [] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.ok(s, 'drying_stats non scritte');
  // Se il buco venisse mediato invece che saltato, il conteggio tornerebbe
  // uguale a quello senza buco: qui deve mancare esattamente un campione.
  assert.equal(s.samples, campioniSenzaBuco - 1,
    `il buco doveva togliere esattamente un campione: ${campioniSenzaBuco} senza buco, ${s.samples} con buco`);
  assert.ok(Math.abs(s.rate_pct_h - 0.5) < 0.05, `attesa ~0.5 %/h, ottenuta ${s.rate_pct_h}`);
});

await t('serie troppo corta: nessuna statistica, nessun crash', async () => {
  const h = banco({ tmp_moisture_series: serieInCalo(1) });
  await statistiche({ payload: [] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.equal(s, undefined, 'con pochi dati non deve pubblicare una stima');
});

await t('tutti i campioni dentro la finestra contaminata: nessuna stima (non e scarsita di dati grezzi)', async () => {
  // 96 punti, ben oltre MIN_CAMPIONI: qui il problema non e' avere pochi
  // dati grezzi (come nel test precedente), ma che ogni singolo punto cade
  // dentro la finestra contaminata di un evento che dura quanto l intera
  // serie: nessuna coppia pulita sopravvive.
  const serie = serieInCalo();
  const chiusura = new Date(serie[serie.length - 1]._time).toISOString();
  const durata = 24 * 3600; // dura quanto la serie: [apertura-30min, chiusura+3h] la copre tutta
  const h = banco({ tmp_moisture_series: serie });
  await statistiche({ payload: [{ _time: chiusura, _value: durata }] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.equal(s, undefined, 'con tutti i campioni contaminati non deve pubblicare una stima');
});

console.log('\n— proiezione e simulazione —');

const simulatore = compila('nf-fn-simula');
const libreria = compila('nr-fn-lib');

function oggiAlle(hh, mm = 0) {
  const d = new Date(); d.setHours(hh, mm, 0, 0); return d.getTime();
}

// Curva meteo sintetica: 96 ore dall ora corrente all indietro di 1,
// ET0 costante di giorno e nulla di notte, pioggia a scelta.
// Ancorata al `now` dello scenario (non a Date.now() reale): altrimenti la
// finestra di 96h e' relativa all ora reale di esecuzione del test invece
// che all ora simulata, e gli indici non combaciano mai (stesso bug gia
// trovato nel parsing meteo, vedi commit 49bc438).
function curva({ et0Giorno = 0.25, pioggiaOra = {}, now = Date.now() } = {}) {
  const oraCorrente = Math.floor(now / 3600000) * 3600;
  const t0 = oraCorrente - 3600;
  const time = Array.from({ length: 96 }, (_, i) => t0 + i * 3600);
  const et0 = time.map((s) => {
    const ora = new Date(s * 1000).getHours();
    return ora >= 7 && ora < 20 ? et0Giorno : 0;
  });
  const precipitation = time.map((_, i) => pioggiaOra[i] || 0);
  return { time, precipitation, et0 };
}

// Config con k gia stimato: la maggior parte dei casi esercita il modello ET0.
// Chi vuole il fallback empirico passa meteo:false o un cfg senza k.
const CFG_K = JSON.parse(JSON.stringify(CFG));
CFG_K.forecast.k_pct_per_mm = 2.0;
CFG_K.forecast.k_pct_per_mm_p10 = 1.2;
CFG_K.forecast.k_pct_per_mm_p90 = 3.0;

function bancoSim({ umidita = [30, 32], now = Date.now(), meteo = true, cfg = CFG_K,
                    last_irrigation_at = 0, stats = { rate_pct_h: 0.5, p10: 0.3, p90: 0.8, samples: 200, computed_at: Date.now() },
                    pioggiaOra = {} } = {}) {
  const h = banco({
    soil_moisture_cache: Object.fromEntries(umidita.map((v, i) => [`WH51_0${i + 1}`, { value: v, ts: now - 60000 }])),
    last_irrigation_at,
    valve_reachable: true,
    drying_stats: stats,
    weather_cache: meteo ? { fetched_at: now - 60000, precip_next_24h_mm: 0, hourly: curva({ pioggiaOra, now }) } : null,
  });
  h.store.irrigation_config = JSON.parse(JSON.stringify(cfg));
  return h;
}

async function simula(h, now = Date.now()) {
  await libreria({}, h.node, h.global, h.env, h.fs);
  const vero = Date.now;
  Date.now = () => now;
  try { return await simulatore({}, h.node, h.global, h.env, h.fs); }
  finally { Date.now = vero; }
}

await t('terreno secco dentro la finestra: apre subito', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [30, 32], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.ok(f.next_irrigation, 'nessuna previsione prodotta');
  assert.ok(Math.abs(new Date(f.next_irrigation.predicted_at).getTime() - now) < 20 * 60000);
  assert.equal(f.next_irrigation.expected_duration_seconds, 900);
});

await t('secco ma fuori finestra: la regola limitante e out_of_window', async () => {
  const now = oggiAlle(14, 0);
  const h = bancoSim({ umidita: [30, 32], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.ok(f.next_irrigation);
  assert.equal(f.next_irrigation.limiting_rule, 'out_of_window');
  const previsto = new Date(f.next_irrigation.predicted_at);
  assert.equal(previsto.getHours(), 19, 'attesa apertura alla finestra serale');
});

await t('terreno bagnato: si asciuga e apre piu avanti', async () => {
  const now = oggiAlle(6, 30);
  // 50% con ET0 diurna 0.25 mm/h e k=2.0 -> ~0.5 %/h di giorno: ~1.5 giorni
  // per scendere sotto 40, dentro l orizzonte di 72h.
  const h = bancoSim({ umidita: [50, 50], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.ok(f.next_irrigation, 'con ET0 positiva deve prima o poi scendere sotto soglia');
  assert.ok(new Date(f.next_irrigation.predicted_at).getTime() > now + 6 * 3600000);
});

// Le due prove seguenti sostituiscono un test precedente che nominava il
// gate giorno/notte senza vincolarlo: la finestra oraria mascherava il
// difetto (con o senza gate, l apertura finiva comunque non prima delle 6,
// perche' la regola out_of_window la spostava li' in entrambi i casi). Qui
// si osserva la grandezza direttamente (a) e si sceglie uno scenario dove
// la finestra oraria non puo' mascherare nulla (b, soglia di emergenza).

await t('di notte la velocita di asciugatura proiettata e nulla (ET0 notturno = 0)', async () => {
  const now = oggiAlle(1, 0);
  const h = bancoSim({ umidita: [41, 41], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.current.drying_rate_pct_h, 0,
    `a notte fonda, con ET0 nullo in curva a quell ora, la velocita proiettata deve essere 0, non ${f.current.drying_rate_pct_h}`);
});

await t('di notte la proiezione non scivola in emergenza: ferma fino alla finestra dell alba', async () => {
  const now = oggiAlle(1, 0);
  // Umidita appena sopra la soglia di emergenza (25%). Se la proiezione
  // asciugasse anche di notte, scenderebbe sotto soglia nel cuore della
  // notte e la regola di emergenza scavalcherebbe la finestra oraria,
  // aprendo prima dell alba. Con ET0 notturno a zero l umidita resta ferma:
  // l apertura arriva solo quando si apre la finestra mattutina (06:00),
  // per la regola ordinaria, non per emergenza. La finestra oraria qui non
  // puo' mascherare il difetto: lo rende visibile come differenza di orario
  // e di trigger.
  const h = bancoSim({ umidita: [26, 26], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.ok(f.next_irrigation, 'attesa comunque un apertura entro l orizzonte');
  assert.notEqual(f.next_irrigation.trigger, 'emergency',
    'la proiezione e scesa in emergenza di notte: il gate giorno/notte non ha tenuto');
  const ora = new Date(f.next_irrigation.predicted_at).getHours();
  assert.equal(ora, 6, `attesa apertura alle 06:00 (finestra mattutina), non prima: ottenuta alle ${ora}`);
});

await t('pioggia abbondante nell orizzonte: nessuna irrigazione, motivo rain_forecast', async () => {
  const now = oggiAlle(6, 30);
  const pioggia = {}; for (let i = 2; i < 30; i++) pioggia[i] = 2;
  const h = bancoSim({ umidita: [39, 39], now, pioggiaOra: pioggia });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.next_irrigation, null);
  assert.equal(f.no_irrigation_reason, 'rain_forecast');
});

await t('la pioggia vince sull umidita alta nel riportare il motivo', async () => {
  const now = oggiAlle(6, 30);
  // Piove per tutto l orizzonte: l umidita sale sopra soglia, quindi entrambe
  // le regole bloccano. Deve essere riportata rain_forecast, che spiega di piu.
  const pioggia = {}; for (let i = 0; i < 96; i++) pioggia[i] = 2;
  const h = bancoSim({ umidita: [30, 30], now, pioggiaOra: pioggia });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.next_irrigation, null);
  assert.equal(f.no_irrigation_reason, 'rain_forecast');
});

await t('umidita alta e stabile: motivo moisture_sufficient', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [80, 80], now, meteo: true });
  h.store.weather_cache.hourly.et0 = h.store.weather_cache.hourly.et0.map(() => 0);
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.next_irrigation, null);
  assert.equal(f.no_irrigation_reason, 'moisture_sufficient');
});

await t('senza meteo passa a empirical e abbassa la confidenza', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [45, 45], now, meteo: false });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.model.method, 'empirical');
  assert.ok(f.confidence.level < 4);
  assert.ok(f.confidence.reasons.some((r) => /meteo/i.test(r)));
});

await t('senza regole registrate non inventa nulla', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [30, 32], now });
  const vero = Date.now; Date.now = () => now;
  try { await simulatore({}, h.node, h.global, h.env, h.fs); } finally { Date.now = vero; }
  assert.equal(h.store.irrigation_forecast, undefined);
  assert.ok(h.warns.some((w) => /orto_rules/.test(w)));
});

await t('quorum insufficiente: nessuna previsione, motivo no_quorum', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [30], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.next_irrigation, null);
  assert.equal(f.no_irrigation_reason, 'no_quorum');
});

await t('sistema in pausa: motivo paused', async () => {
  const now = oggiAlle(6, 30);
  const cfg = JSON.parse(JSON.stringify(CFG)); cfg.mode = 'paused';
  const h = bancoSim({ umidita: [30, 32], now, cfg });
  await simula(h, now);
  assert.equal(h.store.irrigation_forecast.no_irrigation_reason, 'paused');
});

await t('la fascia contiene la stima centrale ed e ordinata', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [55, 55], now });
  await simula(h, now);
  const n = h.store.irrigation_forecast.next_irrigation;
  if (n) {
    const a = new Date(n.band_start).getTime();
    const c = new Date(n.predicted_at).getTime();
    const b = new Date(n.band_end).getTime();
    assert.ok(a <= c && c <= b, `fascia incoerente: ${n.band_start} / ${n.predicted_at} / ${n.band_end}`);
  }
});

await t('sonde in disaccordo: confidenza piu bassa', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [10, 70], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.ok(f.confidence.reasons.some((r) => /disaccordo/i.test(r)));
});

await t('il point per InfluxDB esce come secondo output', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [30, 32], now });
  const out = await simula(h, now);
  assert.ok(Array.isArray(out), 'attesi due output');
  assert.equal(out[1].measurement, 'irrigation_forecast');
  assert.equal(out[1].payload[1].method, 'et0');
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
