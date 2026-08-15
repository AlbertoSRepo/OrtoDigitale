import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LABEL, deregistra, idPerCanale, nuovoId, puoDeregistrare, registra, rinomina, validaRegistro,
} from './registryOps.ts';
import type { RegistrySensor } from '../api/registry.ts';

const s = (id: string, ch: number, placement: RegistrySensor['placement'] = null): RegistrySensor =>
  ({ sensor_id: id, channel: ch, label: '', registered_at: 0, placement, gateway: null });

const BASE = [s('WH51_01', 1), s('WH51_02', 2)];

test('idPerCanale mette lo zero davanti', () => {
  assert.equal(idPerCanale(3), 'WH51_03');
  assert.equal(idPerCanale(11), 'WH51_11');
});

test('registra: aggiunge con id derivato dal canale', () => {
  const out = registra(BASE, 5);
  assert.equal(out.length, 3);
  assert.equal(out[2].sensor_id, 'WH51_05');
  assert.equal(out[2].channel, 5);
  assert.equal(out[2].placement, null, 'nasce libera');
  assert.deepEqual(validaRegistro(out), []);
});

test('registra: un canale già registrato non produce doppioni', () => {
  assert.equal(registra(BASE, 1), BASE);
});

test('registra: se l id naturale è preso ne cerca uno libero', () => {
  // WH51_03 esiste ma agganciato al canale 7: registrando il canale 3
  // l'id naturale sarebbe occupato.
  const con = [...BASE, s('WH51_03', 7)];
  const out = registra(con, 3);
  assert.equal(out.length, 4);
  assert.notEqual(out[3].sensor_id, 'WH51_03');
  assert.equal(out[3].channel, 3);
  assert.deepEqual(validaRegistro(out), [], 'nessun id o canale duplicato');
});

test('nuovoId non restituisce mai un id già preso', () => {
  const pieno = Array.from({ length: 8 }, (_, i) => s(idPerCanale(i + 1), i + 1));
  assert.ok(!pieno.some((x) => x.sensor_id === nuovoId(pieno, 3)));
});

test('deregistra toglie solo quello indicato', () => {
  const out = deregistra(BASE, 'WH51_01');
  assert.deepEqual(out.map((x) => x.sensor_id), ['WH51_02']);
});

test('rinomina cambia solo l etichetta del bersaglio', () => {
  const out = rinomina(BASE, 'WH51_02', 'fondo fila');
  assert.equal(out[0].label, '');
  assert.equal(out[1].label, 'fondo fila');
  assert.equal(out[1].channel, 2, 'il resto non si tocca');
});

test('puoDeregistrare è falso finché la sonda è piazzata', () => {
  assert.equal(puoDeregistrare(s('WH51_01', 1)), true);
  assert.equal(puoDeregistrare(s('WH51_01', 1, { fila: 2, x: 0.3 })), false);
});

test('nessuna operazione muta l array in ingresso', () => {
  const prima = JSON.stringify(BASE);
  registra(BASE, 5);
  deregistra(BASE, 'WH51_01');
  rinomina(BASE, 'WH51_01', 'x');
  assert.equal(JSON.stringify(BASE), prima);
});

test('la validazione riconosce le rotture note', () => {
  const casi: [string, RegistrySensor[]][] = [
    ['bad_sensor_id', [{ ...s('PIPPO', 1) }]],
    ['duplicate_sensor_id', [s('WH51_01', 1), s('WH51_01', 2)]],
    ['bad_channel', [s('WH51_01', 99)]],
    ['duplicate_channel', [s('WH51_01', 1), s('WH51_02', 1)]],
    ['bad_label', [{ ...s('WH51_01', 1), label: 'x'.repeat(MAX_LABEL + 1) }]],
  ];
  for (const [code, reg] of casi) {
    const codici = validaRegistro(reg).map((x) => x.code);
    assert.ok(codici.includes(code), `atteso ${code}, trovati [${codici}]`);
  }
});

test('il registro di partenza è valido', () => {
  assert.deepEqual(validaRegistro(BASE), []);
});
