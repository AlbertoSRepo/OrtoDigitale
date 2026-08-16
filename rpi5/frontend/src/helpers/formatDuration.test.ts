import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtFraQuanto } from './formatDuration.ts';

const ORA = Date.parse('2026-08-16T18:00:00Z');
const fra = (ms: number) => new Date(ORA + ms).toISOString();

test('fmtFraQuanto: minuti', () => {
  assert.equal(fmtFraQuanto(fra(25 * 60_000), ORA), 'fra 25 min');
});

test('fmtFraQuanto: ore', () => {
  assert.equal(fmtFraQuanto(fra(11 * 3600_000), ORA), 'fra 11 h');
});

test('fmtFraQuanto: giorni', () => {
  assert.equal(fmtFraQuanto(fra(3 * 86400_000), ORA), 'fra 3 giorni');
});

test('fmtFraQuanto: istante passato non dice "fa"', () => {
  assert.equal(fmtFraQuanto(fra(-60_000), ORA), 'ora');
});

test('fmtFraQuanto: valore assente', () => {
  assert.equal(fmtFraQuanto(null, ORA), '—');
});
