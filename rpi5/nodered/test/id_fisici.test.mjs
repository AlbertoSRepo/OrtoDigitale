// Banco di prova della scoperta degli ID fisici dal GW3000 (step 18).
//
//   node rpi5/nodered/test/id_fisici.test.mjs
//
// Esegue i corpi dei nodi `richiesta id gateway` e `id fisici dal gateway`
// letti DA flows.json. Quello che qui passa e' esattamente cio' che gira sul
// Raspberry.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compila(nome) {
  const nodo = flows.find((n) => n.name === nome);
  assert.ok(nodo, `nodo ${nome} non trovato in flows.json`);
  try {
    return new AsyncFunction('msg', 'node', 'global', 'env', 'fs', nodo.func);
  } catch (e) {
    console.error(`✗ SINTASSI in ${nome}: ${e.message}`);
    process.exit(1);
  }
}

const richiesta = compila('richiesta id gateway');
const idFisici = compila('id fisici dal gateway');
console.log('✓ sintassi valida per entrambi i nodi');

function banco(env = {}) {
  const warns = [];
  const store = {};
  return {
    warns, store,
    node: { warn: (m) => warns.push(m), log: () => {}, error: (m) => warns.push('ERR ' + m) },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: (k) => env[k] },
    fs: {},
  };
}

/** Slot come li restituisce davvero il GW3000: 16 canali soil, quasi tutti vuoti. */
function slot(img, name, id, extra = {}) {
  return { img, type: '14', name, id, batt: '5', rssi: '-97', signal: '4', idst: '1', ...extra };
}

const PAGINA_SOIL = [
  slot('wh51', 'Soil moisture CH1', 'FC98F'),
  slot('wh51', 'Soil moisture CH2', 'FD067'),
  slot('wh51', 'Soil moisture CH3', 'FD04E'),
  slot('wh51', 'Soil moisture CH4', 'FCDF2'),
  slot('wh51', 'Soil moisture CH5', 'FFFFFFFF', { batt: '9', rssi: '--' }),
  slot('wh51', 'Soil moisture CH6', 'FFFFFFFF', { batt: '9', rssi: '--' }),
];

const PAGINA_METEO = [
  slot('wh85', 'Wind & Rain', 'FFFFFFFF'),
  slot('wh25', 'Temp & Humidity & Pressure', 'FFFFFFFE'),
  slot('wh34', 'Temp CH1', 'A1B2C3'),
];

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

const scan = async (h, payload) => idFisici({ payload, statusCode: 200 }, h.node, h.global, h.env, h.fs);

console.log('\n--- richiesta: una per pagina ---');

await t('emette una richiesta per ogni pagina da scandire', async () => {
  const h = banco();
  const out = await richiesta({}, h.node, h.global, h.env, h.fs);
  const msgs = out[0];
  assert.ok(Array.isArray(msgs) && msgs.length >= 4, 'attese almeno 4 pagine');
  assert.ok(msgs.every((m) => m.method === 'GET'));
  const pagine = msgs.map((m) => Number(/page=(\d+)/.exec(m.url)[1]));
  assert.deepEqual(pagine, pagine.map((_, i) => i + 1), 'pagine consecutive da 1');
});

await t('host di default 192.168.1.5 quando env e vuoto', async () => {
  const h = banco();
  const out = await richiesta({}, h.node, h.global, h.env, h.fs);
  assert.ok(out[0][0].url.startsWith('http://192.168.1.5/get_sensors_info'));
});

await t('GW3000_HOST da env ha la precedenza', async () => {
  const h = banco({ GW3000_HOST: '10.0.0.9' });
  const out = await richiesta({}, h.node, h.global, h.env, h.fs);
  assert.ok(out[0][0].url.startsWith('http://10.0.0.9/get_sensors_info'));
});

console.log('\n--- scoperta degli id ---');

await t('associa il canale allid fisico, normalizzato a 6 cifre minuscole', async () => {
  const h = banco();
  await scan(h, JSON.stringify(PAGINA_SOIL));
  const m = h.store.gw_hw_ids;
  assert.equal(m[1].hw_id, '0fc98f');
  assert.equal(m[2].hw_id, '0fd067');
  assert.equal(m[3].hw_id, '0fd04e');
  assert.equal(m[4].hw_id, '0fcdf2');
});

await t('gli slot mai accoppiati non producono un id', async () => {
  const h = banco();
  await scan(h, JSON.stringify(PAGINA_SOIL));
  assert.equal(h.store.gw_hw_ids[5], undefined, 'FFFFFFFF non e un id');
  assert.equal(h.store.gw_hw_ids[6], undefined);
});

await t('accetta il payload gia deserializzato dal nodo http', async () => {
  const h = banco();
  await scan(h, PAGINA_SOIL);
  assert.equal(h.store.gw_hw_ids[1].hw_id, '0fc98f');
});

await t('annota quando lha visto', async () => {
  const h = banco();
  const prima = Date.now();
  await scan(h, JSON.stringify(PAGINA_SOIL));
  assert.ok(h.store.gw_hw_ids[1].ts >= prima);
});

console.log('\n--- pagine che non riguardano le sonde ---');

await t('i sensori non wh51 vengono ignorati', async () => {
  const h = banco();
  await scan(h, JSON.stringify(PAGINA_METEO));
  assert.equal(h.store.gw_hw_ids, undefined, 'nessun wh51: la mappa non nasce nemmeno');
});

await t('una pagina senza sonde non cancella quanto gia scoperto', async () => {
  const h = banco();
  await scan(h, JSON.stringify(PAGINA_SOIL));
  await scan(h, JSON.stringify(PAGINA_METEO));
  assert.equal(h.store.gw_hw_ids[1].hw_id, '0fc98f', 'lo scan e per pagina: le altre non tolgono');
});

await t('uno slot che si svuota toglie il canale dalla mappa', async () => {
  const h = banco();
  await scan(h, JSON.stringify(PAGINA_SOIL));
  const sganciata = PAGINA_SOIL.map((s) =>
    /CH3$/.test(s.name) ? { ...s, id: 'FFFFFFFF' } : s);
  await scan(h, JSON.stringify(sganciata));
  assert.equal(h.store.gw_hw_ids[3], undefined, 'una sonda tolta non deve restare a video');
  assert.equal(h.store.gw_hw_ids[1].hw_id, '0fc98f', 'le altre restano');
});

await t('un canale ri-accoppiato con unaltra sonda aggiorna lid', async () => {
  const h = banco();
  await scan(h, JSON.stringify(PAGINA_SOIL));
  const sostituita = PAGINA_SOIL.map((s) =>
    /CH1$/.test(s.name) ? { ...s, id: 'AB12C' } : s);
  await scan(h, JSON.stringify(sostituita));
  assert.equal(h.store.gw_hw_ids[1].hw_id, '0ab12c');
});

console.log('\n--- risposte malformate ---');

await t('risposta non JSON: avvisa e non rompe nulla', async () => {
  const h = banco();
  await scan(h, '<html>404</html>');
  assert.equal(h.store.gw_hw_ids, undefined);
  assert.ok(h.warns.some((w) => w.includes('GW3000')));
});

await t('risposta non JSON: la mappa precedente sopravvive', async () => {
  const h = banco();
  await scan(h, JSON.stringify(PAGINA_SOIL));
  await scan(h, 'boom');
  assert.equal(h.store.gw_hw_ids[1].hw_id, '0fc98f');
});

await t('array di altro tipo non produce nulla', async () => {
  const h = banco();
  await scan(h, JSON.stringify({ errore: 'nope' }));
  assert.equal(h.store.gw_hw_ids, undefined);
});

await t('slot senza canale nel nome viene saltato', async () => {
  const h = banco();
  await scan(h, JSON.stringify([slot('wh51', 'Soil moisture', 'FC98F')]));
  // La pagina e' di sonde, quindi la mappa nasce: ma senza canale non c'e'
  // niente a cui appendere l'id.
  assert.deepEqual(h.store.gw_hw_ids, {});
});

await t('id non esadecimale viene scartato', async () => {
  const h = banco();
  await scan(h, JSON.stringify([slot('wh51', 'Soil moisture CH1', '--')]));
  assert.equal(h.store.gw_hw_ids[1], undefined);
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
