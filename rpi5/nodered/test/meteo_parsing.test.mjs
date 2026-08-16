// Banco di prova del parsing meteo (step 15, Task 1).
//
//   node rpi5/nodered/test/meteo_parsing.test.mjs
//
// Il corpo della funzione viene letto DA flows.json, non da una copia.
// Verifica che gli aggregati partano dall'ora corrente e non dalla posizione 0
// dell'array, che in Open-Meteo e' mezzanotte del giorno in corso.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compila(id) {
  const nodo = flows.find((n) => n.id === id);
  assert.ok(nodo, `nodo ${id} non trovato in flows.json`);
  return new AsyncFunction('msg', 'node', 'global', 'env', 'fs', nodo.func);
}

const parse = compila('nw-fn-parse-cache');
const scheduler = compila('nw-fn-scheduler');

function banco() {
  const store = {};
  const warns = [];
  return {
    store, warns,
    node: { warn: (m) => warns.push(m), log: () => {}, status: () => {}, error: (m) => warns.push('ERR ' + m) },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: () => undefined },
    fs: {},
  };
}

// La funzione sotto test legge Date.now() una seconda volta (per trovare
// l'ora corrente in hourly.time), oltre a quella usata qui per costruire il
// payload sintetico. Se le due letture cadessero a cavallo di un cambio
// d'ora, l'indice atteso slitterebbe e un'asserzione come quella su
// humidity_now_pct fallirebbe senza che nulla sia davvero rotto. Si congela
// l'orologio per la durata della chiamata cosi' le due letture coincidono
// sempre.
async function esegui(fn, msg, h, ora) {
  const vero = Date.now;
  Date.now = () => ora;
  try {
    return await fn(msg, h.node, h.global, h.env, h.fs);
  } finally {
    Date.now = vero;
  }
}

// Payload sintetico: 96 ore che partono 12 ore PRIMA di `ora`, allineate
// all'ora. Le posizioni 0..11 sono passato, la 12 contiene l'istante
// corrente. Costruito a partire dallo stesso `ora` che viene congelato in
// esegui(), cosi' i due riferimenti temporali non possono divergere.
function payload(ora) {
  const oraCorrente = Math.floor(ora / 3600000) * 3600;
  const t0 = oraCorrente - 12 * 3600;
  const time = Array.from({ length: 96 }, (_, i) => t0 + i * 3600);
  const precipitation = new Array(96).fill(0);
  precipitation[0] = 10;   // gia' caduta stamattina: NON deve contare
  precipitation[20] = 3;   // fra 8 ore: deve contare
  precipitation[40] = 7;   // fra 28 ore: fuori dalla finestra 24h
  const temperature_2m = new Array(96).fill(15);
  temperature_2m[5] = 40;  // picco nel passato: NON deve contare
  temperature_2m[15] = 28; // picco futuro entro 12h: deve contare
  const relative_humidity_2m = new Array(96).fill(50);
  relative_humidity_2m[0] = 99;   // mezzanotte
  relative_humidity_2m[12] = 42;  // adesso
  const et0_fao_evapotranspiration = new Array(96).fill(0.1);
  return { hourly: { time, precipitation, temperature_2m, relative_humidity_2m, et0_fao_evapotranspiration } };
}

// Payload ben formato ma con tutte le 96 ore nel passato rispetto a `ora`:
// nessuna posizione contiene l'istante corrente. Copre il ramo difensivo
// i0 < 0 del parsing.
function payloadSenzaOraCorrente(ora) {
  const oraCorrente = Math.floor(ora / 3600000) * 3600;
  const t0 = oraCorrente - 96 * 3600;
  const time = Array.from({ length: 96 }, (_, i) => t0 + i * 3600);
  return {
    hourly: {
      time,
      precipitation: new Array(96).fill(0),
      temperature_2m: new Array(96).fill(15),
      relative_humidity_2m: new Array(96).fill(50),
      et0_fao_evapotranspiration: new Array(96).fill(0.1),
    },
  };
}

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

await t('la pioggia gia caduta oggi non entra in precip_next_24h_mm', async () => {
  const h = banco();
  const ora = Date.now();
  await esegui(parse, { payload: payload(ora), statusCode: 200, _t0: ora }, h, ora);
  const wc = h.store.weather_cache;
  assert.ok(wc, 'weather_cache non scritta');
  assert.equal(wc.precip_next_24h_mm, 3, 'deve contare solo i 3mm futuri entro 24h');
});

await t('humidity_now_pct e l ora corrente, non mezzanotte', async () => {
  const h = banco();
  const ora = Date.now();
  await esegui(parse, { payload: payload(ora), statusCode: 200, _t0: ora }, h, ora);
  assert.equal(h.store.weather_cache.humidity_now_pct, 42);
});

await t('temp_max_next_12h_c ignora il picco passato', async () => {
  const h = banco();
  const ora = Date.now();
  await esegui(parse, { payload: payload(ora), statusCode: 200, _t0: ora }, h, ora);
  assert.equal(h.store.weather_cache.temp_max_next_12h_c, 28);
});

await t('la curva oraria finisce in cache per il simulatore', async () => {
  const h = banco();
  const ora = Date.now();
  await esegui(parse, { payload: payload(ora), statusCode: 200, _t0: ora }, h, ora);
  const hourly = h.store.weather_cache.hourly;
  assert.ok(hourly, 'manca weather_cache.hourly');
  assert.equal(hourly.time.length, 96);
  assert.equal(hourly.precipitation.length, 96);
  assert.equal(hourly.et0.length, 96);
});

await t('il point InfluxDB contiene solo aggregati, mai la curva', async () => {
  const h = banco();
  const ora = Date.now();
  const out = await esegui(parse, { payload: payload(ora), statusCode: 200, _t0: ora }, h, ora);
  assert.equal(out.measurement, 'weather_forecast');
  assert.equal(out.payload[0].hourly, undefined, 'la curva non deve finire su InfluxDB');
  assert.equal(out.payload[0].time, undefined);
});

await t('risposta non valida non svuota la cache esistente', async () => {
  const h = banco();
  h.store.weather_cache = { precip_next_24h_mm: 1, fetched_at: 123 };
  const ora = Date.now();
  const out = await esegui(parse, { payload: null, statusCode: 500 }, h, ora);
  assert.equal(out, null);
  assert.equal(h.store.weather_cache.precip_next_24h_mm, 1, 'cache preesistente persa');
});

await t('nessuna ora contiene l istante corrente: cache preesistente intatta e warn loggato', async () => {
  const h = banco();
  h.store.weather_cache = { precip_next_24h_mm: 1, fetched_at: 123 };
  const ora = Date.now();
  const out = await esegui(parse, { payload: payloadSenzaOraCorrente(ora), statusCode: 200, _t0: ora }, h, ora);
  assert.equal(out, null, 'con i0 < 0 il nodo deve restituire null');
  assert.equal(h.store.weather_cache.precip_next_24h_mm, 1, 'cache preesistente persa');
  assert.ok(h.warns.some((w) => w.includes('istante corrente')), 'deve avvisare che l indice orario non e stato trovato');
});

await t('l URL chiede et0, 5 giorni e unixtime', async () => {
  const h = banco();
  h.store.irrigation_config = {
    weather: { polling_interval_seconds: 1800, api_url: 'https://api.open-meteo.com/v1/forecast', lat: 45.7, lon: 9.7 },
  };
  const ora = Date.now();
  const msg = await esegui(scheduler, {}, h, ora);
  assert.ok(msg && msg.url, 'lo scheduler non ha prodotto un URL');
  assert.ok(msg.url.includes('et0_fao_evapotranspiration'), 'manca et0');
  // Open-Meteo conta i giorni da mezzanotte, il simulatore ha bisogno di 96h
  // (72 di orizzonte + 24 di finestra pioggia in coda) da qualunque ora di
  // polling: 4 giorni bastano solo se il polling cade esattamente a
  // mezzanotte, altrimenti la coda dell orizzonte resta cieca alla pioggia
  // (stesso modo di fallire, senza errori, della chiave rain_24h). 5 giorni
  // (120 slot da mezzanotte) coprono le 96h da qualunque ora.
  assert.ok(msg.url.includes('forecast_days=5'), 'servono 5 giorni per coprire 96h da qualunque ora di polling');
  assert.ok(msg.url.includes('timeformat=unixtime'), 'manca timeformat=unixtime');
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
