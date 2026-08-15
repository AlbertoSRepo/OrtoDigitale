import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP, MOBILE, flipOffset, glyphTop, labelHalf, pinY, rowLabelY, rowTop, stampY, totalHeight,
  type OrtoMetrics,
} from './ortoMetrics.ts';

const METRICS: [string, OrtoMetrics][] = [['desktop', DESKTOP], ['mobile', MOBILE]];

for (const [nome, m] of METRICS) {
  // Il caso che è già andato storto una volta: due pin vicini sfalsano la
  // seconda etichetta verso il basso, e quella finisce dentro il timbro.
  test(`${nome}: l'etichetta pin sfalsata non tocca il timbro coltura`, () => {
    const top = rowTop(m, 0);
    const fondoEtichetta = pinY(m, top) + flipOffset(m) + labelHalf(m.fsValue);
    const cimaTimbro = Math.min(glyphTop(m, stampY(m, top)), stampY(m, top) - labelHalf(m.fsSmall));
    assert.ok(
      fondoEtichetta < cimaTimbro,
      `bande sovrapposte: etichetta fino a ${fondoEtichetta.toFixed(1)}, timbro da ${cimaTimbro.toFixed(1)}`,
    );
  });

  test(`${nome}: le due bande stanno dentro la riga`, () => {
    const top = rowTop(m, 0);
    assert.ok(pinY(m, top) - labelHalf(m.fsValue) > top, 'pin sopra il bordo alto');
    const fondoTimbro = stampY(m, top) + m.glyph * 0.38;
    assert.ok(fondoTimbro < top + m.rowH, 'timbro sotto il bordo basso');
  });

  test(`${nome}: le righe non si sovrappongono e stanno nel viewBox`, () => {
    for (let i = 1; i < 3; i++) {
      assert.ok(rowTop(m, i) >= rowTop(m, i - 1) + m.rowH, `fila ${i + 1} sovrapposta`);
    }
    assert.ok(rowTop(m, 2) + m.rowH <= totalHeight(m, 3), 'ultima fila fuori dal viewBox');
  });

  test(`${nome}: l'etichetta di fila sta nel suo spazio, sopra la riga`, () => {
    const top = rowTop(m, 0);
    const y = rowLabelY(m, top);
    assert.ok(y < top, 'etichetta dentro la riga');
    assert.ok(y - labelHalf(m.fsLabel) > top - m.labelH, 'etichetta oltre lo spazio riservato');
  });

  test(`${nome}: il glifo sonda non esce dalla banda pin`, () => {
    const top = rowTop(m, 0);
    const fondoSonda = pinY(m, top) + flipOffset(m) + m.probe / 2;
    assert.ok(fondoSonda < glyphTop(m, stampY(m, top)), 'sonda sfalsata addosso al timbro');
    assert.ok(pinY(m, top) - m.probe / 2 > top, 'sonda sopra il bordo alto');
  });
}
