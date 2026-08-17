// Banco di prova del motivo reale di chiusura valvola.
//
// Prima di questo fix, in mode=auto il campo `reason` di irrigation_events
// derivava dal *trigger di apertura* ('scheduled'), non dalla causa di
// chiusura: threshold_reached e safety_timeout collassavano nella stessa
// stringa, ed erano indistinguibili a posteriori. Chi chiude ora lascia un
// testimone in global.last_close_reason; chi scrive il record lo raccoglie.
//
//   node rpi5/nodered/test/motivo_chiusura.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));
const CFG = JSON.parse(readFileSync(QUI + '../data/irrigation_config.json', 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compila(id) {
  const nodo = flows.find((n) => n.id === id);
  assert.ok(nodo, `nodo ${id} non trovato`);
  return new AsyncFunction('msg', 'node', 'global', 'env', 'context', nodo.func);
}
const monitoring = compila('nd-fn-monitoring');
const safety = compila('n-fn-valve-safety');
const evento = compila('n-fn-valve-irrigation-event');

// Banco: global store + sonde in cache. `mode` e' sovrascrivibile perche' il
// file di config nel repo non e' autoritativo per quel campo (sul RPi e' auto).
function banco({ mode = 'auto', medie = [50, 50, 50, 50], eta_ms = 0 } = {}) {
  const cfg = JSON.parse(JSON.stringify(CFG));
  cfg.mode = mode;
  const now = Date.now();
  const cache = {};
  medie.forEach((v, i) => { cache['WH51_0' + (i + 1)] = { value: v, ts: now - eta_ms }; });
  const store = { irrigation_config: cfg, soil_moisture_cache: cache };
  const ctx = {};
  return {
    store,
    now,
    node: { warn: () => {}, log: () => {}, status: () => {}, error: () => {}, send: () => {} },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: () => undefined },
    context: { set: (k, v) => { ctx[k] = v; }, get: (k) => ctx[k] },
  };
}

// Estrae il campo reason dal record irrigation_events prodotto dal nodo.
const reasonDi = (out) => out.payload[0].reason;

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

console.log('\nmotivo di chiusura — testimone lasciato da chi chiude');

await t('monitoring: media oltre la soglia di chiusura lascia threshold_reached', async () => {
  const h = banco({ medie: [70, 70, 70, 70] });
  h.store.opened_at = h.now - 60_000; // 1 min: safety non c'entra
  await monitoring({}, h.node, h.global, h.env, h.context);
  assert.equal(h.store.last_close_reason.reason, 'threshold_reached');
});

await t('monitoring: target sforato lascia safety_timeout', async () => {
  const h = banco({ medie: [45, 45, 45, 45] }); // sotto il 65%: chiude solo per tempo
  h.store.opened_at = h.now - 1000 * 1000; // 1000s > safety_timeout 900s
  await monitoring({}, h.node, h.global, h.env, h.context);
  assert.equal(h.store.last_close_reason.reason, 'safety_timeout');
});

await t('monitoring: irrigazione in corso non lascia nessun testimone', async () => {
  const h = banco({ medie: [50, 50, 50, 50] });
  h.store.opened_at = h.now - 60_000;
  await monitoring({}, h.node, h.global, h.env, h.context);
  assert.equal(h.store.last_close_reason, undefined, 'niente testimone se non chiude');
});

// Il testimone del safety timer nasce dentro il setTimeout: per leggerlo
// serve catturare la callback armata e invocarla, senza aspettare 15 minuti.
async function scattaTimer(h, runtime) {
  h.store.valve_runtime = runtime;
  const vero = globalThis.setTimeout;
  let callback = null, ms = null;
  globalThis.setTimeout = (fn, delay) => { callback = fn; ms = delay; return { armato: true }; };
  try {
    await safety({ payload: { state: 'ON' } }, h.node, h.global, h.env, h.context);
  } finally {
    globalThis.setTimeout = vero;
  }
  assert.ok(callback, 'il timer deve essere armato');
  callback(); // simula lo scadere
  return ms / 1000;
}

await t('safety timer: apertura manuale scaduta lascia manual_duration_reached', async () => {
  const h = banco();
  const durata = await scattaTimer(h, { requested_duration: 600 }); // >= 60 => manuale
  assert.equal(durata, 600, 'durata manuale richiesta rispettata');
  assert.equal(h.store.last_close_reason.reason, 'manual_duration_reached');
});

await t('safety timer: cap auto scaduto lascia safety_timeout', async () => {
  const h = banco();
  const durata = await scattaTimer(h, {}); // nessuna requested_duration => auto
  assert.equal(durata, CFG.irrigation.safety_timeout_seconds, 'usa il cap safety');
  assert.equal(h.store.last_close_reason.reason, 'safety_timeout');
});

await t('safety timer: manuale oltre il cap viene clampato ma resta manuale', async () => {
  const h = banco();
  const durata = await scattaTimer(h, { requested_duration: 99999 });
  assert.equal(durata, CFG.irrigation.manual_max_duration_seconds, 'clamp a manual_max');
  assert.equal(h.store.last_close_reason.reason, 'manual_duration_reached');
});

console.log('\nmotivo di chiusura — testimone raccolto da chi scrive');

// Prepara un evento aperto, come dopo un state=ON.
async function apri(h, trigger) {
  h.store.last_cmd_source = trigger;
  await evento({ payload: { state: 'ON' } }, h.node, h.global, h.env, h.context);
}

await t('auto chiuso per soglia: reason = threshold_reached (non piu "scheduled")', async () => {
  const h = banco({ medie: [70, 70, 70, 70] });
  await apri(h, 'auto');
  h.store.last_close_reason = { reason: 'threshold_reached', ts: Date.now() };
  const out = await evento({ payload: { state: 'OFF' } }, h.node, h.global, h.env, h.context);
  assert.equal(reasonDi(out), 'threshold_reached');
});

await t('auto chiuso per timeout: reason = safety_timeout', async () => {
  const h = banco({ medie: [48, 48, 48, 48] });
  await apri(h, 'auto');
  h.store.last_close_reason = { reason: 'safety_timeout', ts: Date.now() };
  const out = await evento({ payload: { state: 'OFF' } }, h.node, h.global, h.env, h.context);
  assert.equal(reasonDi(out), 'safety_timeout');
});

await t('i due motivi auto sono distinguibili fra loro', async () => {
  const soglia = banco({ medie: [70, 70, 70, 70] });
  await apri(soglia, 'auto');
  soglia.store.last_close_reason = { reason: 'threshold_reached', ts: Date.now() };
  const a = reasonDi(await evento({ payload: { state: 'OFF' } }, soglia.node, soglia.global, soglia.env, soglia.context));

  const timeout = banco({ medie: [48, 48, 48, 48] });
  await apri(timeout, 'auto');
  timeout.store.last_close_reason = { reason: 'safety_timeout', ts: Date.now() };
  const b = reasonDi(await evento({ payload: { state: 'OFF' } }, timeout.node, timeout.global, timeout.env, timeout.context));

  assert.notEqual(a, b, 'e_ questo che prima era impossibile leggere da InfluxDB');
});

await t('testimone stantio (5 min) non viene attribuito: fallback al trigger', async () => {
  const h = banco();
  await apri(h, 'auto');
  h.store.last_close_reason = { reason: 'threshold_reached', ts: Date.now() - 5 * 60 * 1000 };
  const out = await evento({ payload: { state: 'OFF' } }, h.node, h.global, h.env, h.context);
  assert.equal(reasonDi(out), 'scheduled', 'oltre 120s il testimone non e_ credibile');
});

await t('nessun testimone: fallback al comportamento precedente', async () => {
  const h = banco();
  await apri(h, 'manual');
  const out = await evento({ payload: { state: 'OFF' } }, h.node, h.global, h.env, h.context);
  assert.equal(reasonDi(out), 'comando manuale');
});

await t('trigger emergency conserva il suo motivo quando non c_e_ testimone', async () => {
  const h = banco();
  await apri(h, 'emergency');
  const out = await evento({ payload: { state: 'OFF' } }, h.node, h.global, h.env, h.context);
  assert.equal(reasonDi(out), 'emergency');
});

await t('il testimone viene azzerato dopo la scrittura del record', async () => {
  const h = banco();
  await apri(h, 'auto');
  h.store.last_close_reason = { reason: 'safety_timeout', ts: Date.now() };
  await evento({ payload: { state: 'OFF' } }, h.node, h.global, h.env, h.context);
  assert.equal(h.store.last_close_reason, null, 'niente residui per la chiusura successiva');
});

console.log('\nnon-regressione');

await t('dry_run continua a scrivere il record di chiusura con il motivo giusto', async () => {
  const h = banco({ mode: 'dry_run', medie: [70, 70, 70, 70] });
  h.store.opened_at = h.now - 60_000;
  h.store.irrigation_open = { avg_at_trigger: 38, trigger: 'auto' };
  const out = await monitoring({}, h.node, h.global, h.env, h.context);
  const record = out[1];
  assert.ok(record, 'in dry_run il record lo scrive il monitoring');
  assert.equal(record.payload[0].reason, 'threshold_reached');
  assert.equal(record.measurement, 'irrigation_events');
});

await t('lo schema del record resta invariato (nessun campo aggiunto o perso)', async () => {
  const h = banco();
  await apri(h, 'auto');
  h.store.last_close_reason = { reason: 'safety_timeout', ts: Date.now() };
  const out = await evento({ payload: { state: 'OFF' } }, h.node, h.global, h.env, h.context);
  const campi = Object.keys(out.payload[0]).sort();
  assert.deepEqual(campi, [
    'avg_moisture_at_close', 'avg_moisture_at_trigger', 'delta_moisture', 'dry_run',
    'duration_seconds', 'liters_method', 'liters_sample_count', 'reason',
    'rain_forecast_mm', 'sensor_count', 'sensors_high_variance', 'state',
    'total_liters', 'weather_available', 'weather_data_age_seconds',
  ].sort(), 'reason cambia solo contenuto, lo schema no');
  assert.deepEqual(Object.keys(out.payload[1]).sort(), ['trigger', 'valve_id']);
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
