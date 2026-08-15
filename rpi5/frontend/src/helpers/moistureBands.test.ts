// node --test src/helpers/moistureBands.test.ts   (Node 24: type-stripping nativo)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moistureBands } from './moistureBands.ts';

test('fila senza sonde: nessuna zona', () => {
  assert.deepEqual(moistureBands([]), []);
});

test('una sonda sola copre tutta la fila', () => {
  assert.deepEqual(moistureBands([{ sensor_id: 'A', x: 0.2 }]), [
    { sensor_id: 'A', from: 0, to: 1 },
  ]);
});

test('due sonde: confine a metà strada, estremi ai bordi', () => {
  assert.deepEqual(moistureBands([{ sensor_id: 'A', x: 0.2 }, { sensor_id: 'B', x: 0.8 }]), [
    { sensor_id: 'A', from: 0, to: 0.5 },
    { sensor_id: 'B', from: 0.5, to: 1 },
  ]);
});

test('ordine di ingresso irrilevante', () => {
  const a = moistureBands([{ sensor_id: 'B', x: 0.8 }, { sensor_id: 'A', x: 0.2 }]);
  const b = moistureBands([{ sensor_id: 'A', x: 0.2 }, { sensor_id: 'B', x: 0.8 }]);
  assert.deepEqual(a, b);
});

test('le zone sono contigue e coprono [0,1] senza buchi', () => {
  const bands = moistureBands([
    { sensor_id: 'A', x: 0.1 },
    { sensor_id: 'B', x: 0.45 },
    { sensor_id: 'C', x: 0.9 },
  ]);
  assert.equal(bands[0].from, 0);
  assert.equal(bands[bands.length - 1].to, 1);
  for (let i = 1; i < bands.length; i++) assert.equal(bands[i].from, bands[i - 1].to);
});

test('non muta l\'array in ingresso', () => {
  const input = [{ sensor_id: 'B', x: 0.8 }, { sensor_id: 'A', x: 0.2 }];
  moistureBands(input);
  assert.equal(input[0].sensor_id, 'B');
});
