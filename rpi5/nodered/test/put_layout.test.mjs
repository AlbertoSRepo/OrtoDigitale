// Banco di prova del nodo Node-RED `PUT /api/layout` (step 13).
//
//   node rpi5/nodered/test/put_layout.test.mjs
//
// Il corpo della funzione viene letto DA flows.json, non da una copia: quello
// che qui passa e' esattamente cio' che gira sul Raspberry. Il filesystem e'
// finto, quindi il test non tocca nulla.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const FLOWS = QUI + '../data/flows.json';
const SEED_PATH = QUI + '../data/orto_layout.seed.json';

const nodo = JSON.parse(readFileSync(FLOWS, 'utf8')).find((n) => n.id === 'ol-fn-put');
assert.ok(nodo, 'nodo ol-fn-put non trovato in flows.json');
const body = nodo.func;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let run;
try {
  run = new AsyncFunction('msg', 'node', 'global', 'env', 'fs', body);
  console.log('✓ sintassi valida sotto il wrapper Node-RED');
} catch (e) {
  console.error('✗ SINTASSI: ' + e.message);
  process.exit(1);
}

const SEED = JSON.parse(readFileSync(SEED_PATH, 'utf8'));

const clone = (o) => JSON.parse(JSON.stringify(o));

function harness(contenutoLive) {
  const files = contenutoLive ? { '/data/orto_layout.json': JSON.stringify(contenutoLive) } : {};
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
    env: { get: (k) => (k === 'INFLUX_TOKEN_NODERED_EVENTS_RW' ? 'FINTO' : undefined) },
  };
}

async function put(doc, live = SEED) {
  const h = harness(live);
  const msg = { payload: doc };
  const out = await run(msg, h.node, h.global, h.env, h.fs);
  return { msg: out[0], eventi: out[1], h };
}

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

console.log('\n--- validazione ---');
await t('il seed valido passa e risponde 200', async () => {
  const r = await put(clone(SEED));
  assert.equal(r.msg.statusCode, 200);
  assert.equal(r.msg.payload.file.length, 3);
});

const casi = [
  ['bad_file_set', (d) => { d.file.pop(); }],
  ['not_closed', (d) => { d.file[0].aree[0].to = 0.9; }],
  ['area_too_narrow', (d) => { d.file[1].aree[0].to = 0.01; }],
  ['not_increasing', (d) => { d.file[2].aree[1].to = 0.1; }],
  ['unknown_crop', (d) => { d.file[0].aree[0].crop = 'kiwi'; }],
  ['bad_plant_count', (d) => { d.file[0].aree[0].n = 99; }],
  ['bad_plant_count', (d) => { d.file[1].aree[0].n = 3; }],       // libero con n>0
  ['unknown_sensor', (d) => { d.file[0].sensori[0].sensor_id = 'PIPPO'; }],
  ['duplicate_sensor', (d) => { d.file[1].sensori[0].sensor_id = 'WH51_01'; }],
  ['x_out_of_range', (d) => { d.file[0].sensori[0].x = 1.7; }],
  ['sensor_too_close', (d) => { d.file[0].sensori[1].x = d.file[0].sensori[0].x + 0.01; }],
  ['too_many_areas', (d) => { d.file[0].aree = Array.from({ length: 6 }, (_, i) => ({ crop: 'libero', to: (i + 1) / 6, n: 0 })); }],
];
for (const [code, rompi] of casi) {
  await t(`rifiuta con ${code}`, async () => {
    const d = clone(SEED); rompi(d);
    const r = await put(d);
    assert.equal(r.msg.statusCode, 400, 'doveva rispondere 400');
    const trovati = r.msg.payload.errors.map((x) => x.code);
    assert.ok(trovati.includes(code), `atteso ${code}, trovati [${trovati}]`);
    assert.equal(r.eventi, null, 'un 400 non deve scrivere eventi');
  });
}

console.log('\n--- scrittura ---');
await t('scrive in modo atomico e lascia il .bak col contenuto precedente', async () => {
  const d = clone(SEED); d.file[0].aree[0].n = 7;
  const r = await put(d);
  assert.ok(!('/data/orto_layout.json.tmp' in r.h.files), 'il temporaneo deve sparire');
  assert.equal(JSON.parse(r.h.files['/data/orto_layout.json']).file[0].aree[0].n, 7);
  assert.equal(JSON.parse(r.h.files['/data/orto_layout.json.bak']).file[0].aree[0].n, 5);
});
await t('updated_at viene imposto dal server', async () => {
  const d = clone(SEED); d.updated_at = 42;
  const r = await put(d);
  assert.ok(r.msg.payload.updated_at > 1e9, 'updated_at del client ignorato');
});
await t('global.orto_layout viene aggiornato', async () => {
  const r = await put(clone(SEED));
  assert.equal(r.h.store.orto_layout.file.length, 3);
});

console.log('\n--- diff sensor_moves ---');
await t('nessun evento se le sonde non si muovono', async () => {
  const d = clone(SEED); d.file[2].aree[0].crop = 'lattuga';   // cambia solo una coltura
  const r = await put(d);
  assert.equal(r.eventi, null);
});
await t('delta sotto 0.005 e ignorato come rumore', async () => {
  const d = clone(SEED); d.file[0].sensori[0].x += 0.004;
  const r = await put(d);
  assert.equal(r.eventi, null);
});
await t('move: stessa fila, x diversa', async () => {
  const d = clone(SEED); d.file[0].sensori[0].x = 0.4;
  const r = await put(d);
  assert.match(r.eventi.payload, /^sensor_moves,sensor_id=WH51_01,action=move /);
  assert.match(r.eventi.payload, /changed_aiuola=false/);
  assert.match(r.eventi.payload, /from_x=0.124,to_x=0.4/);
});
await t('reassign: fila diversa, changed_aiuola=true', async () => {
  const d = clone(SEED);
  const s = d.file[0].sensori.pop();          // WH51_02 da fila 1
  d.file[2].sensori.push(s);                  // a fila 3
  const r = await put(d);
  assert.match(r.eventi.payload, /sensor_id=WH51_02,action=reassign/);
  assert.match(r.eventi.payload, /from_aiuola=1i,to_aiuola=3i/);
  assert.match(r.eventi.payload, /changed_aiuola=true/);
});
await t('remove e place', async () => {
  const d = clone(SEED);
  d.file[0].sensori.pop();                                        // rimuove WH51_02
  d.file[2].sensori.push({ sensor_id: 'WH51_05', x: 0.5 });        // piazza WH51_05
  const r = await put(d);
  assert.match(r.eventi.payload, /sensor_id=WH51_02,action=remove .*to_aiuola=-1i/);
  assert.match(r.eventi.payload, /sensor_id=WH51_05,action=place .*from_aiuola=-1i/);
});
await t('la richiesta a InfluxDB e formata bene', async () => {
  const d = clone(SEED); d.file[0].sensori[0].x = 0.4;
  const r = await put(d);
  assert.equal(r.eventi.method, 'POST');
  assert.match(r.eventi.url, /bucket=events.*precision=ns/);
  assert.equal(r.eventi.headers.Authorization, 'Token FINTO');
});
await t('senza token: warning, ma il salvataggio resta valido', async () => {
  const h = harness(SEED);
  h.env.get = () => undefined;
  const d = clone(SEED); d.file[0].sensori[0].x = 0.4;
  const msg = { payload: d };
  const out = await run(msg, h.node, h.global, h.env, h.fs);
  assert.equal(out[0].statusCode, 200, 'il layout si salva comunque');
  assert.equal(out[1], null);
  assert.ok(h.warns.some((w) => w.includes('EVENTS_RW')), 'atteso un warning sul token');
});
await t('primo salvataggio senza layout preesistente: tutti place', async () => {
  const r = await put(clone(SEED), null);
  const n = (r.eventi.payload.match(/action=place/g) || []).length;
  assert.equal(n, 4, 'attesi 4 place, trovati ' + n);
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
