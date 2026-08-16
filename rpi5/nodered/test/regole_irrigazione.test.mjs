// Fotografia della catena di regole del decision loop (step 15, Task 3).
//
//   node rpi5/nodered/test/regole_irrigazione.test.mjs
//
// Questo file NON va modificato durante l'estrazione in `libreria regole`:
// e' la prova che il comportamento non e' cambiato. La seconda meta' esercita
// direttamente valutaRegole, e ha senso solo dopo l'estrazione.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function nodoPerNome(nome) {
  const n = flows.find((x) => x.name === nome);
  assert.ok(n, `nodo "${nome}" non trovato in flows.json`);
  return new AsyncFunction('msg', 'node', 'global', 'env', 'fs', n.func);
}
function nodoPerId(id) {
  const n = flows.find((x) => x.id === id);
  return n ? new AsyncFunction('msg', 'node', 'global', 'env', 'fs', n.func) : null;
}

const decisione = nodoPerNome('decision logic');

const CFG = {
  irrigation: {
    soglia_apertura_pct: 40, soglia_chiusura_pct: 65, soglia_emergenza_pct: 25,
    cooldown_seconds: 7200, safety_timeout_seconds: 900,
    manual_max_duration_seconds: 3600, emergency_duration_seconds: 300,
    finestra_mattina: ['06:00', '08:00'], finestra_sera: ['19:00', '01:00'],
    polling_interval_seconds: 300, monitoring_interval_seconds: 60,
  },
  weather: { polling_interval_seconds: 1800, cache_max_age_seconds: 5400, rain_threshold_mm: 5, rain_window_hours: 24 },
  valve: { command_timeout_seconds: 30, max_retries: 1, unreachable_alert_after: 3 },
  sensors: { max_age_seconds: 1800, min_quorum: 2, stddev_warning_pct: 25 },
  mode: 'auto', pause_until: null,
};

// Costruisce un istante di oggi all'ora voluta, in fuso locale (come fa inWindow).
function oggiAlle(hh, mm = 0) {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

function banco({ umidita = [], now = oggiAlle(6, 30), cfg = CFG, meteo = null,
                 last_irrigation_at = 0, reachable = true } = {}) {
  const store = {
    irrigation_config: JSON.parse(JSON.stringify(cfg)),
    soil_moisture_cache: Object.fromEntries(umidita.map((v, i) => [`WH51_0${i + 1}`, { value: v, ts: now - 60000 }])),
    last_irrigation_at,
    valve_reachable: reachable,
    weather_cache: meteo,
  };
  const warns = [];
  const h = {
    store, warns,
    node: { warn: (m) => warns.push(m), log: () => {}, status: () => {}, error: (m) => warns.push('ERR ' + m) },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: () => undefined },
    fs: {},
  };
  // Le regole vivono in un nodo a parte, che le registra in global all'avvio
  // del flow: il banco fa lo stesso, altrimenti il decision loop si troverebbe
  // senza. Finche' `nr-fn-lib` non esiste la riga e' un no-op, per questo i 12
  // casi qui sotto valgono identici da una parte e dall'altra dell'estrazione.
  const lib = nodoPerId('nr-fn-lib');
  if (lib) lib({}, h.node, h.global, h.env, h.fs);
  return h;
}

// Il nodo legge Date.now(): si congela il tempo per la durata della chiamata.
async function decidi(h, now) {
  const vero = Date.now;
  Date.now = () => now;
  try {
    return await decisione({}, h.node, h.global, h.env, h.fs);
  } finally {
    Date.now = vero;
  }
}

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

console.log('— fotografia del decision loop —');

await t('umidita sufficiente: nessun evento, esito ok', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [50, 52, 48, 51], now });
  const out = await decidi(h, now);
  assert.equal(out, null, 'non deve produrre alcun messaggio');
  assert.match(h.store.last_decision_outcome, /^ok:moist=/);
});

await t('quorum insufficiente blocca prima di tutto il resto', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [10], now });
  await decidi(h, now);
  assert.equal(h.store.last_decision_outcome, 'skip:no_quorum');
});

await t('sistema in pausa: skip:paused anche con terreno secco', async () => {
  const now = oggiAlle(6, 30);
  const cfg = JSON.parse(JSON.stringify(CFG)); cfg.mode = 'paused';
  const h = banco({ umidita: [10, 12], now, cfg });
  await decidi(h, now);
  assert.equal(h.store.last_decision_outcome, 'skip:paused');
});

await t('secco ma fuori finestra: skip:out_of_window', async () => {
  const now = oggiAlle(14, 0);
  const h = banco({ umidita: [30, 32], now });
  await decidi(h, now);
  assert.equal(h.store.last_decision_outcome, 'skip:out_of_window');
});

await t('sotto soglia emergenza la finestra oraria viene scavalcata', async () => {
  const now = oggiAlle(14, 0);
  const h = banco({ umidita: [20, 22], now });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^open:emergency@/);
});

await t('finestra serale che attraversa la mezzanotte: alle 23 si e dentro', async () => {
  const now = oggiAlle(23, 0);
  const h = banco({ umidita: [30, 32], now });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^open:auto@/);
});

await t('finestra serale che attraversa la mezzanotte: alle 00:30 si e ancora dentro', async () => {
  const now = oggiAlle(0, 30);
  const h = banco({ umidita: [30, 32], now });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^open:auto@/);
});

await t('cooldown non scaduto: skip:cooldown', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [30, 32], now, last_irrigation_at: now - 3600_000 });
  await decidi(h, now);
  assert.equal(h.store.last_decision_outcome, 'skip:cooldown');
});

await t('pioggia prevista sopra soglia: skip:rain_delay', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [30, 32], now, meteo: { fetched_at: now - 60000, precip_next_24h_mm: 12 } });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^skip:rain_delay/);
});

await t('meteo stantio: la pioggia non blocca', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [30, 32], now, meteo: { fetched_at: now - 6 * 3600_000, precip_next_24h_mm: 12 } });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^open:auto@/);
});

await t('valvola irraggiungibile: skip e contatore che sale', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [30, 32], now, reachable: false });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^skip:valve_unreachable/);
  assert.equal(h.store.valve_unreachable_consecutive, 1);
});

await t('condizioni piene: apre in auto', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [30, 32], now });
  const out = await decidi(h, now);
  assert.ok(Array.isArray(out), 'attesi tre output');
  assert.equal(out[0].payload.state, 'ON');
  assert.match(h.store.last_decision_outcome, /^open:auto@/);
});

console.log('\n— regole pure (valgono solo dopo l estrazione) —');

const libreria = nodoPerId('nr-fn-lib');

await t('la libreria registra valutaRegole in global', async () => {
  assert.ok(libreria, 'nodo nr-fn-lib non ancora presente in flows.json');
  const h = banco({});
  await libreria({}, h.node, h.global, h.env, h.fs);
  assert.equal(typeof h.store.orto_rules.valutaRegole, 'function');
});

await t('valutaRegole e pura: stessi ingressi, stessa uscita', async () => {
  const h = banco({});
  await libreria({}, h.node, h.global, h.env, h.fs);
  const { valutaRegole } = h.store.orto_rules;
  const stato = {
    now: oggiAlle(6, 30), moisture_mean: 30, sensor_count: 4, last_irrigation_at: 0,
    weather: { available: false, rain_24h: 0 }, valve_reachable: true,
    mode: 'auto', pause_until: null, cfg: CFG,
  };
  const a = valutaRegole(stato);
  const b = valutaRegole(stato);
  assert.deepEqual(a, b);
  assert.equal(a.azione, 'apri');
  assert.equal(a.trigger, 'auto');
});

await t('valutaRegole non tocca global ne l orologio', async () => {
  const h = banco({});
  await libreria({}, h.node, h.global, h.env, h.fs);
  const { valutaRegole } = h.store.orto_rules;
  const chiaviPrima = Object.keys(h.store).sort().join(',');
  valutaRegole({
    now: oggiAlle(14, 0), moisture_mean: 30, sensor_count: 4, last_irrigation_at: 0,
    weather: { available: false, rain_24h: 0 }, valve_reachable: true,
    mode: 'auto', pause_until: null, cfg: CFG,
  });
  assert.equal(Object.keys(h.store).sort().join(','), chiaviPrima, 'ha scritto su global');
});

await t('valutaRegole riporta la regola bloccante, non solo l azione', async () => {
  const h = banco({});
  await libreria({}, h.node, h.global, h.env, h.fs);
  const { valutaRegole } = h.store.orto_rules;
  const r = valutaRegole({
    now: oggiAlle(14, 0), moisture_mean: 30, sensor_count: 4, last_irrigation_at: 0,
    weather: { available: false, rain_24h: 0 }, valve_reachable: true,
    mode: 'auto', pause_until: null, cfg: CFG,
  });
  assert.equal(r.azione, 'attendi');
  assert.equal(r.regola, 'out_of_window');
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
