// Banco di prova del registro sensori (step 14).
//
//   node rpi5/nodered/test/registro_sensori.test.mjs
//
// Esegue i corpi dei nodi `parse WH51` e `registro sensori` letti DA flows.json,
// con filesystem finto. Quello che qui passa e' esattamente cio' che gira sul
// Raspberry.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));
const SEED = readFileSync(QUI + '../data/orto_sensors.seed.json', 'utf8');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compila(nome, chiave = 'name') {
  const nodo = flows.find((n) => n[chiave] === nome);
  assert.ok(nodo, `nodo ${nome} non trovato in flows.json`);
  try {
    return new AsyncFunction('msg', 'node', 'global', 'env', 'fs', nodo.func);
  } catch (e) {
    console.error(`✗ SINTASSI in ${nome}: ${e.message}`);
    process.exit(1);
  }
}

const parse = compila('parse WH51 -> points + cache');
const registro = compila('registro sensori');
console.log('✓ sintassi valida per entrambi i nodi');

const PAYLOAD_4CH =
  'runtime=1&soilmoisture1=50&soilbatt1=1.5&soilmoisture2=44&soilbatt2=1.6' +
  '&soilmoisture3=41&soilbatt3=1.6&soilmoisture4=46&soilbatt4=1.5&model=GW3000A';
const PAYLOAD_5CH = PAYLOAD_4CH + '&soilmoisture5=12&soilbatt5=1.4';

function banco(files = {}) {
  const warns = [];
  const store = {};
  return {
    files, warns, store,
    fs: {
      promises: {
        readFile: async (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
        writeFile: async (p, c) => { files[p] = c; },
        rename: async (a, b) => { files[b] = files[a]; delete files[a]; },
      },
    },
    node: { warn: (m) => warns.push(m), log: () => {}, error: (m) => warns.push('ERR ' + m) },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: () => undefined },
  };
}

const conSeed = () => banco({ '/data/orto_sensors.seed.json': SEED });

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

console.log('\n--- ingest filtrato dal registro ---');

await t('scrive solo i canali registrati', async () => {
  const h = conSeed();
  const out = await parse({ payload: PAYLOAD_5CH }, h.node, h.global, h.env, h.fs);
  const ids = out.payload.map((p) => p[1].sensor_id).sort();
  assert.deepEqual(ids, ['WH51_01', 'WH51_02', 'WH51_03', 'WH51_04']);
  assert.equal(out.payload.length, 4, 'il canale 5 non registrato non va scritto');
});

await t('il canale non registrato finisce comunque in gw_seen', async () => {
  const h = conSeed();
  await parse({ payload: PAYLOAD_5CH }, h.node, h.global, h.env, h.fs);
  assert.ok(h.store.gw_seen[5], 'canale 5 assente dalla scoperta');
  assert.equal(h.store.gw_seen[5].moisture, 12);
  assert.equal(h.store.gw_seen[5].battery_v, 1.4);
});

await t('la cache irrigazione non contiene i non registrati', async () => {
  const h = conSeed();
  await parse({ payload: PAYLOAD_5CH }, h.node, h.global, h.env, h.fs);
  assert.deepEqual(Object.keys(h.store.soil_moisture_cache).sort(),
    ['WH51_01', 'WH51_02', 'WH51_03', 'WH51_04']);
});

await t('fail-open: senza registro scrive tutti i canali e avvisa', async () => {
  const h = banco();
  const out = await parse({ payload: PAYLOAD_5CH }, h.node, h.global, h.env, h.fs);
  assert.equal(out.payload.length, 5, 'attesi 5 canali in fail-open');
  assert.ok(h.warns.some((w) => w.includes('Registro sensori illeggibile')));
});

await t('deregistrando, la sonda esce dalla cache dell irrigazione', async () => {
  const h = conSeed();
  await parse({ payload: PAYLOAD_4CH }, h.node, h.global, h.env, h.fs);
  assert.equal(Object.keys(h.store.soil_moisture_cache).length, 4);
  // il registro perde WH51_04
  const ridotto = JSON.parse(SEED);
  ridotto.sensori = ridotto.sensori.filter((s) => s.sensor_id !== 'WH51_04');
  h.store.orto_sensors = ridotto;
  await parse({ payload: PAYLOAD_4CH }, h.node, h.global, h.env, h.fs);
  assert.deepEqual(Object.keys(h.store.soil_moisture_cache).sort(),
    ['WH51_01', 'WH51_02', 'WH51_03'], 'il valore vecchio peserebbe sulla media');
});

await t('registrando un canale, i suoi punti compaiono subito', async () => {
  const h = conSeed();
  const esteso = JSON.parse(SEED);
  esteso.sensori.push({ sensor_id: 'WH51_05', channel: 5, label: '', registered_at: 1 });
  h.store.orto_sensors = esteso;
  const out = await parse({ payload: PAYLOAD_5CH }, h.node, h.global, h.env, h.fs);
  assert.ok(out.payload.some((p) => p[1].sensor_id === 'WH51_05'));
});

await t('il canale segue il registro, non il numero: ch 5 -> WH51_01', async () => {
  const h = conSeed();
  const rimappato = JSON.parse(SEED);
  rimappato.sensori[0].channel = 5;          // WH51_01 ri-agganciato al canale 5
  h.store.orto_sensors = rimappato;
  const out = await parse({ payload: PAYLOAD_5CH }, h.node, h.global, h.env, h.fs);
  const uno = out.payload.find((p) => p[1].sensor_id === 'WH51_01');
  assert.ok(uno, 'WH51_01 deve restare, sul canale nuovo');
  assert.equal(uno[0].value, 12, 'deve portare il valore del canale 5');
});

console.log('\n--- GET /api/sensors/registry ---');

async function get(h) {
  const msg = { req: { method: 'GET' } };
  return (await registro(msg, h.node, h.global, h.env, h.fs)).payload;
}

await t('elenca i registrati con la posizione dal layout', async () => {
  const h = conSeed();
  h.store.orto_layout = {
    file: [
      { id: 1, aree: [], sensori: [{ sensor_id: 'WH51_01', x: 0.124 }] },
      { id: 2, aree: [], sensori: [] },
      { id: 3, aree: [], sensori: [] },
    ],
  };
  const p = await get(h);
  assert.equal(p.sensori.length, 4);
  assert.deepEqual(p.sensori[0].placement, { fila: 1, x: 0.124 });
  assert.equal(p.sensori[1].placement, null, 'non piazzata = libera');
});

await t('rilevati contiene solo i canali non registrati', async () => {
  const h = conSeed();
  await parse({ payload: PAYLOAD_5CH }, h.node, h.global, h.env, h.fs);
  const p = await get(h);
  assert.deepEqual(p.rilevati.map((r) => r.channel), [5]);
  assert.equal(p.rilevati[0].moisture, 12);
});

await t('gateway e null per un sensore mai visto', async () => {
  const h = conSeed();
  const p = await get(h);
  assert.equal(p.sensori[0].gateway, null);
});

await t('gateway valorizzato dopo una lettura', async () => {
  const h = conSeed();
  await parse({ payload: PAYLOAD_4CH }, h.node, h.global, h.env, h.fs);
  const p = await get(h);
  assert.equal(p.sensori[0].gateway.moisture, 50);
  assert.ok(p.sensori[0].gateway.seen_seconds_ago < 5);
});

console.log('\n--- PUT /api/sensors/registry ---');

async function put(h, body) {
  const msg = { req: { method: 'PUT' }, payload: body };
  return await registro(msg, h.node, h.global, h.env, h.fs);
}

await t('salva un registro valido', async () => {
  const h = conSeed();
  const body = JSON.parse(SEED);
  body.sensori.push({ sensor_id: 'WH51_05', channel: 5, label: 'nuova', registered_at: 0 });
  const r = await put(h, body);
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(h.files['/data/orto_sensors.json']).sensori.length, 5);
  assert.ok(!('/data/orto_sensors.json.tmp' in h.files), 'il temporaneo deve sparire');
});

await t('updated_at e registered_at li mette il server', async () => {
  const h = conSeed();
  const body = JSON.parse(SEED);
  body.updated_at = 42;
  body.sensori.push({ sensor_id: 'WH51_07', channel: 7, label: '' });
  const r = await put(h, body);
  assert.ok(r.payload.updated_at > 1e9);
  assert.ok(r.payload.sensori.find((s) => s.sensor_id === 'WH51_07').registered_at > 1e9);
});

const rotture = [
  ['bad_sensor_id', (b) => { b.sensori[0].sensor_id = 'PIPPO'; }],
  ['duplicate_sensor_id', (b) => { b.sensori[1].sensor_id = 'WH51_01'; }],
  ['bad_channel', (b) => { b.sensori[0].channel = 99; }],
  ['duplicate_channel', (b) => { b.sensori[1].channel = 1; }],
  ['bad_label', (b) => { b.sensori[0].label = 'x'.repeat(61); }],
];
for (const [code, rompi] of rotture) {
  await t(`rifiuta con ${code}`, async () => {
    const h = conSeed();
    const body = JSON.parse(SEED);
    rompi(body);
    const r = await put(h, body);
    assert.equal(r.statusCode, 400);
    const trovati = r.payload.errors.map((x) => x.code);
    assert.ok(trovati.includes(code), `atteso ${code}, trovati [${trovati}]`);
  });
}

await t('deregistrare una sonda piazzata e bloccato', async () => {
  const h = conSeed();
  h.store.orto_layout = {
    file: [{ id: 2, aree: [], sensori: [{ sensor_id: 'WH51_03', x: 0.1 }] }],
  };
  const body = JSON.parse(SEED);
  body.sensori = body.sensori.filter((s) => s.sensor_id !== 'WH51_03');
  const r = await put(h, body);
  assert.equal(r.statusCode, 400);
  assert.ok(r.payload.errors.some((e) => e.code === 'sensor_in_use'));
  assert.ok(r.payload.errors[0].message.includes('fila 2'), 'il messaggio deve dire dove sta');
});

await t('deregistrare una sonda libera e permesso', async () => {
  const h = conSeed();
  h.store.orto_layout = { file: [{ id: 1, aree: [], sensori: [] }] };
  const body = JSON.parse(SEED);
  body.sensori = body.sensori.filter((s) => s.sensor_id !== 'WH51_03');
  const r = await put(h, body);
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.sensori.length, 3);
});

await t('il salvataggio aggiorna global: la lettura dopo usa il registro nuovo', async () => {
  const h = conSeed();
  const body = JSON.parse(SEED);
  body.sensori.push({ sensor_id: 'WH51_05', channel: 5, label: '', registered_at: 0 });
  await put(h, body);
  const out = await parse({ payload: PAYLOAD_5CH }, h.node, h.global, h.env, h.fs);
  assert.equal(out.payload.length, 5, 'il canale 5 deve essere scritto senza riavvii');
});

console.log('\n--- il layout viene letto da file, non solo da global ---');

const LAYOUT_PIAZZATO = JSON.stringify({
  version: 1, updated_at: 0,
  file: [
    { id: 1, aree: [], sensori: [{ sensor_id: 'WH51_01', x: 0.124 }] },
    { id: 2, aree: [], sensori: [{ sensor_id: 'WH51_03', x: 0.103 }] },
    { id: 3, aree: [], sensori: [] },
  ],
});

// Dopo un riavvio global e' vuoto: se il nodo si fidasse solo di quello, tutte
// le sonde risulterebbero libere e il blocco alla deregistrazione non
// scatterebbe. E' successo davvero, al primo deploy sul Raspberry.
const dopoRiavvio = () => banco({
  '/data/orto_sensors.seed.json': SEED,
  '/data/orto_layout.json': LAYOUT_PIAZZATO,
});

await t('a global vuoto la posizione arriva comunque dal file', async () => {
  const h = dopoRiavvio();
  const p = await get(h);
  assert.deepEqual(p.sensori[0].placement, { fila: 1, x: 0.124 });
  assert.equal(p.sensori[1].placement, null, 'WH51_02 e davvero libera');
});

await t('a global vuoto il blocco alla deregistrazione scatta lo stesso', async () => {
  const h = dopoRiavvio();
  const body = JSON.parse(SEED);
  body.sensori = body.sensori.filter((s) => s.sensor_id !== 'WH51_01');
  const r = await put(h, body);
  assert.equal(r.statusCode, 400, 'senza il file si sarebbe potuta cancellare');
  assert.ok(r.payload.errors.some((e) => e.code === 'sensor_in_use'));
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
