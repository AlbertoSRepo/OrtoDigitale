// Banco di prova della sezione forecast del config store (step 15, Task 2).
//
//   node rpi5/nodered/test/config_forecast.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));
const CFG = JSON.parse(readFileSync(QUI + '../data/irrigation_config.json', 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compila(id) {
  const nodo = flows.find((n) => n.id === id);
  assert.ok(nodo, `nodo ${id} non trovato`);
  return new AsyncFunction('msg', 'node', 'global', 'env', 'fs', nodo.func);
}
const validaHttp = compila('nc-fn-validate-http');
const validaMqtt = compila('nc-fn-validate-mqtt');

function banco(cfg) {
  const store = { irrigation_config: JSON.parse(JSON.stringify(cfg)) };
  return {
    store,
    node: { warn: () => {}, log: () => {}, status: () => {}, error: () => {} },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: () => undefined },
    fs: {},
  };
}

const setHttp = async (h, dotPath, value) => {
  const [msg] = await validaHttp(
    { req: { params: { 0: dotPath } }, payload: { value } },
    h.node, h.global, h.env, h.fs,
  );
  return msg;
};

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

await t('il file di config ha la sezione forecast completa', async () => {
  assert.ok(CFG.forecast, 'sezione forecast assente');
  for (const k of ['enabled', 'horizon_hours', 'step_minutes', 'recompute_interval_seconds',
    'stats_refresh_interval_seconds', 'stats_window_days', 'k_pct_per_mm',
    'k_pct_per_mm_p10', 'k_pct_per_mm_p90', 'rain_gain_pct_per_mm',
    'fallback_drying_rate_pct_h']) {
    assert.ok(k in CFG.forecast, `manca forecast.${k}`);
  }
  assert.equal(CFG.forecast.k_pct_per_mm, null, 'k deve partire null finche non e stimato');
});

await t('si puo impostare forecast.horizon_hours via HTTP', async () => {
  const h = banco(CFG);
  const msg = await setHttp(h, 'forecast.horizon_hours', 48);
  assert.equal(msg.statusCode, 200);
  assert.equal(h.store.irrigation_config.forecast.horizon_hours, 48);
});

await t('un orizzonte fuori scala viene rifiutato', async () => {
  const h = banco(CFG);
  const msg = await setHttp(h, 'forecast.horizon_hours', 500);
  assert.equal(msg.statusCode, 400);
});

await t('k puo essere rimesso a null', async () => {
  const h = banco(CFG);
  const msg = await setHttp(h, 'forecast.k_pct_per_mm', null);
  assert.equal(msg.statusCode, 200);
  assert.equal(h.store.irrigation_config.forecast.k_pct_per_mm, null);
});

await t('lo stesso path e accettato anche via MQTT', async () => {
  const h = banco(CFG);
  const out = await validaMqtt(
    { topic: 'orto/config/set/forecast/step_minutes', payload: '30' },
    h.node, h.global, h.env, h.fs,
  );
  const res = Array.isArray(out) ? out[0] : out;
  assert.equal(res.payload.ok, true, `MQTT ha rifiutato: ${JSON.stringify(res.payload)}`);
  assert.equal(h.store.irrigation_config.forecast.step_minutes, 30);
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
