import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP, MOBILE, clampProbe, flipOffset, glyphTop, labelHalf, labelX, pinY, rowLabelY,
  rowTop, stampY, textW, totalHeight, type OrtoMetrics,
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

// --- Contenimento nella riga ------------------------------------------------
// Requisito esplicito: valore e identificativo della sonda non escono mai dalla
// riga. Prima della correzione l'etichetta di WH51_02 (x = 0.866 su una fila
// lunga 830 unità) sforava di 6 unità a destra.

const LUNGHEZZE = [0.722, 0.790, 1.0];

for (const [nome, m] of METRICS) {
  test(`${nome}: nessuna etichetta sonda esce dalla riga, per qualunque x`, () => {
    const etichetta = '02 · 100%';
    const lw = textW(etichetta, m.fsValue) + m.fsValue * 0.9; // col marchio batteria
    for (const len of LUNGHEZZE) {
      const w = (m.proportional ? len : 1) * m.vw;
      for (let i = 0; i <= 100; i++) {
        const cx = clampProbe((i / 100) * w, m.probe, w);
        const x0 = labelX(cx, lw, w, m.probe * 0.6);
        assert.ok(x0 >= 0, `x=${i / 100} len=${len}: etichetta sfora a sinistra (${x0.toFixed(1)})`);
        assert.ok(
          x0 + lw <= w + 1e-9,
          `x=${i / 100} len=${len}: etichetta sfora a destra (${(x0 + lw).toFixed(1)} > ${w.toFixed(1)})`,
        );
      }
    }
  });

  test(`${nome}: il glifo sonda resta dentro la riga agli estremi`, () => {
    const w = m.vw * 0.722;
    for (const x of [0, 0.5, 1]) {
      const cx = clampProbe(x * w, m.probe, w);
      assert.ok(cx - m.probe / 2 >= -1e-9 && cx + m.probe / 2 <= w + 1e-9, `x=${x}`);
    }
  });

  test(`${nome}: l'etichetta passa a sinistra quando a destra non ci sta`, () => {
    const w = 400;
    const lw = 100;
    assert.equal(labelX(50, lw, w, 10), 60, 'con spazio a destra deve stare a destra');
    assert.ok(labelX(395, lw, w, 10) < 395, 'vicino al bordo destro deve ribaltarsi a sinistra');
  });
}
