import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MIN_AREA, MIN_DIST, addSensor, areaFrom, canSplit, changeSensor, mergeArea, moveDivider,
  moveSensor, placedSensors, removeSensor, setCrop, setPlantCount, splitArea, validateLayout,
} from './layoutOps.ts';
import type { Layout } from '../api/types.ts';

// Il seed reale, non un fixture inventato: se cambia, i test lo seguono.
const SEED: Layout = JSON.parse(
  readFileSync(new URL('../../../nodered/data/orto_layout.seed.json', import.meta.url), 'utf8'),
);
const clone = (): Layout => JSON.parse(JSON.stringify(SEED));
const fila = (l: Layout, id: number) => l.file.find((r) => r.id === id)!;

test('il seed è valido', () => {
  assert.deepEqual(validateLayout(SEED), []);
});

test('nessuna operazione muta il layout in ingresso', () => {
  const l = clone();
  const prima = JSON.stringify(l);
  splitArea(l, 1, 0.5);
  mergeArea(l, 2, 1, 'left');
  setCrop(l, 1, 0, 'lattuga');
  moveDivider(l, 2, 0, 0.5);
  moveSensor(l, 'WH51_01', 1, 0.7);
  removeSensor(l, 'WH51_02');
  assert.equal(JSON.stringify(l), prima);
});

// --- aree -------------------------------------------------------------------

test('split: la partizione resta chiusa a 1 e la coltura si eredita', () => {
  const out = splitArea(clone(), 1, 0.5);
  const r = fila(out, 1);
  assert.equal(r.aree.length, 2);
  assert.equal(r.aree[r.aree.length - 1].to, 1);
  assert.equal(r.aree[0].crop, 'pomodoro');
  assert.equal(r.aree[1].crop, 'pomodoro');
  assert.deepEqual(validateLayout(out), []);
});

test('split: le piante si ripartiscono in proporzione', () => {
  const out = splitArea(clone(), 1, 0.6); // 5 pomodori, taglio al 60%
  const r = fila(out, 1);
  assert.equal(r.aree[0].n + r.aree[1].n, 5, 'nessuna pianta persa o creata');
  assert.equal(r.aree[0].n, 3);
});

test('split rifiutato a 5 aree e troppo vicino a un confine', () => {
  let l = clone();
  for (const at of [0.2, 0.4, 0.6, 0.8]) l = splitArea(l, 1, at);
  assert.equal(fila(l, 1).aree.length, 5);
  assert.equal(canSplit(fila(l, 1), 0.5), false, 'sesta area non ammessa');
  assert.equal(splitArea(l, 1, 0.5), l, 'deve restituire lo stesso layout');
  assert.equal(canSplit(fila(clone(), 2), 0.371), false, 'a 0.002 da un confine');
});

test('merge: unisce, somma le piante e resta valido', () => {
  const out = mergeArea(clone(), 3, 1, 'left'); // lattuga x2 <- zucchina x3
  const r = fila(out, 3);
  assert.equal(r.aree.length, 3);
  assert.equal(r.aree[0].crop, 'lattuga', 'tiene la coltura di quella su cui si è agito');
  assert.equal(r.aree[0].n, 5);
  assert.equal(r.aree[0].to, 0.463);
  assert.deepEqual(validateLayout(out), []);
});

test('merge ai bordi non fa nulla', () => {
  const l = clone();
  assert.equal(mergeArea(l, 3, 0, 'left'), l);
  assert.equal(mergeArea(l, 3, 3, 'right'), l);
});

test('setCrop: libero azzera le piante, e uscendo da libero ne mette una', () => {
  const a = setCrop(clone(), 1, 0, 'libero');
  assert.equal(fila(a, 1).aree[0].n, 0);
  const b = setCrop(clone(), 2, 0, 'lattuga'); // fila 2 area 0 è libero
  assert.equal(fila(b, 2).aree[0].n, 1);
  assert.deepEqual(validateLayout(b), []);
});

test('setPlantCount: limitato a 0..20 e inerte su libero', () => {
  assert.equal(fila(setPlantCount(clone(), 1, 0, 99), 1).aree[0].n, 20);
  assert.equal(fila(setPlantCount(clone(), 1, 0, -3), 1).aree[0].n, 0);
  const l = clone();
  assert.equal(setPlantCount(l, 2, 0, 4), l, 'libero non prende piante');
});

test('moveDivider: muove entrambe le adiacenti e non scende sotto il minimo', () => {
  const r0 = fila(clone(), 2);
  const stretto = moveDivider(clone(), 2, 0, 0.001);
  const r = fila(stretto, 2);
  assert.ok(r.aree[0].to >= MIN_AREA - 1e-9, 'clampato al minimo');
  assert.equal(r.aree[1].to, r0.aree[1].to, 'il confine successivo non si muove');
  assert.deepEqual(validateLayout(stretto), []);

  const largo = moveDivider(clone(), 2, 0, 0.999);
  assert.ok(fila(largo, 2).aree[0].to <= fila(largo, 2).aree[1].to - MIN_AREA + 1e-9);
});

test('moveDivider: qualunque valore produce sempre un layout valido', () => {
  for (let i = 0; i <= 200; i++) {
    const out = moveDivider(clone(), 3, 1, (i / 200) * 1.4 - 0.2);
    assert.deepEqual(validateLayout(out), [], `to = ${(i / 200) * 1.4 - 0.2}`);
  }
});

// --- sonde ------------------------------------------------------------------

test('moveSensor nella stessa fila rispetta la distanza minima', () => {
  const out = moveSensor(clone(), 'WH51_01', 1, 0.86); // addosso a WH51_02 (0.866)
  const r = fila(out, 1);
  const xs = r.sensori.map((s) => s.x).sort((a, b) => a - b);
  assert.ok(xs[1] - xs[0] >= MIN_DIST - 1e-9, `distanza ${xs[1] - xs[0]}`);
  assert.deepEqual(validateLayout(out), []);
});

test('moveSensor resta dentro [0,1] anche oltre i bordi', () => {
  for (const x of [-5, -0.1, 1.1, 9]) {
    const out = moveSensor(clone(), 'WH51_03', 2, x);
    const s = placedSensors(out).get('WH51_03')!;
    assert.ok(s.x >= 0 && s.x <= 1, `x=${x} -> ${s.x}`);
  }
});

test('moveSensor in un altra fila lo sposta, non lo duplica', () => {
  const out = moveSensor(clone(), 'WH51_01', 3, 0.5);
  assert.equal(fila(out, 1).sensori.length, 1);
  assert.equal(placedSensors(out).get('WH51_01')!.fila, 3);
  assert.deepEqual(validateLayout(out), []);
});

test('addSensor di uno già piazzato non ne crea due', () => {
  const out = addSensor(clone(), 3, 'WH51_02', 0.4);
  const tutti = out.file.flatMap((r) => r.sensori.map((s) => s.sensor_id));
  assert.equal(tutti.filter((id) => id === 'WH51_02').length, 1);
  assert.deepEqual(validateLayout(out), []);
});

test('changeSensor mantiene la posizione', () => {
  const prima = placedSensors(clone()).get('WH51_01')!;
  const out = changeSensor(clone(), 'WH51_01', 'WH51_05');
  const dopo = placedSensors(out).get('WH51_05')!;
  assert.equal(dopo.fila, prima.fila);
  assert.equal(dopo.x, prima.x);
  assert.equal(placedSensors(out).has('WH51_01'), false);
});

test('removeSensor toglie solo quello indicato', () => {
  const out = removeSensor(clone(), 'WH51_03');
  assert.equal(placedSensors(out).has('WH51_03'), false);
  assert.equal(placedSensors(out).size, 3);
  assert.deepEqual(validateLayout(out), []);
});

// --- validazione ------------------------------------------------------------

test('la validazione riconosce le rotture note', () => {
  const casi: [string, (l: Layout) => void][] = [
    ['not_closed', (l) => { fila(l, 1).aree[0].to = 0.9; }],
    ['area_too_narrow', (l) => { fila(l, 2).aree[0].to = 0.01; }],
    ['unknown_crop', (l) => { fila(l, 1).aree[0].crop = 'kiwi'; }],
    ['bad_plant_count', (l) => { fila(l, 2).aree[0].n = 3; }],
    ['duplicate_sensor', (l) => { fila(l, 2).sensori[0].sensor_id = 'WH51_01'; }],
    ['sensor_too_close', (l) => { fila(l, 1).sensori[1].x = fila(l, 1).sensori[0].x + 0.01; }],
    ['x_out_of_range', (l) => { fila(l, 1).sensori[0].x = 2; }],
  ];
  for (const [code, rompi] of casi) {
    const l = clone();
    rompi(l);
    const codici = validateLayout(l).map((e) => e.code);
    assert.ok(codici.includes(code), `atteso ${code}, trovati [${codici}]`);
  }
});

test('areaFrom concatena i bordi', () => {
  const r = fila(clone(), 3);
  assert.equal(areaFrom(r, 0), 0);
  assert.equal(areaFrom(r, 2), r.aree[1].to);
});
