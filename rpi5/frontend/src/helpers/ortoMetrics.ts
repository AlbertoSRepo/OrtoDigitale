/**
 * Metriche della mappa orto, in unità viewBox.
 *
 * Le proporzioni orizzontali non cambiano mai col breakpoint (step 12, D6):
 * cambia solo quanto è alta una riga e dove sta l'etichetta di fila. Su mobile
 * la riga è molto più alta in rapporto alla larghezza, altrimenti scalando a
 * schermo stretto le etichette si schiacciano.
 *
 * Stanno in un file a parte, e non dentro OrtoMap.tsx, perché le due bande
 * verticali (pin sopra, timbri coltura sotto) devono restare separate anche
 * quando un'etichetta viene sfalsata: è una condizione numerica, e ha un test.
 */

export interface OrtoMetrics {
  /** Larghezza utile: fila 3 la occupa tutta. */
  vw: number;
  rowH: number;
  gap: number;
  pad: number;
  /** Spazio sopra ogni riga per l'etichetta "FILA n - media". */
  labelH: number;
  fsValue: number;
  fsSmall: number;
  /**
   * Lato del riquadro in cui sta il glifo coltura. **È questo il parametro da
   * toccare per ingrandire o rimpicciolire le icone delle colture.**
   *
   * Ha un tetto, imposto da tre vincoli che `ortoMetrics.test.ts` verifica:
   * il glifo non deve pestare l'etichetta di una sonda sfalsata, né il glifo
   * della sonda stessa, né uscire dal bordo basso della riga. In pratica:
   *
   *     glyph_max ≈ min(
   *       (stampY − pinY − flipOffset − labelHalf(fsValue)) / 0.62,
   *       (rowH − stampY) / 0.38
   *     )
   *
   * Con i valori attuali il tetto è ~89 su desktop e ~137 su mobile. Per andare
   * oltre bisogna prima alzare `rowH`. Non serve calcolarlo a mano: alza `glyph`
   * e lancia `npm test` — se hai passato il limite i test falliscono dicendo
   * quale vincolo hai rotto.
   */
  glyph: number;
  /** Lato del glifo sonda. */
  probe: number;
  fsLabel: number;
  /** Se false tutte le file sono lunghe uguale: su schermo stretto le
   *  proporzioni reali (0.722 / 0.790 / 1) sprecano larghezza senza dire nulla. */
  proportional: boolean;
  /** Larghezza minima dell'area, in unità viewBox, perché il timbro mostri
   *  rispettivamente nome, conteggio e glifo. `Infinity` = mai. */
  labelMinPx: number;
  countMinPx: number;
  glyphMinPx: number;
}

export const DESKTOP: OrtoMetrics = {
  vw: 1150, rowH: 170, gap: 22, pad: 14, labelH: 30,
  fsValue: 22, fsSmall: 13, fsLabel: 13, glyph: 84, probe: 26,
  proportional: true,
  labelMinPx: 150, countMinPx: 80, glyphMinPx: 34,
};

// Su mobile: file tutte uguali, e nel timbro resta il solo glifo.
export const MOBILE: OrtoMetrics = {
  vw: 1000, rowH: 260, gap: 26, pad: 16, labelH: 46,
  fsValue: 34, fsSmall: 20, fsLabel: 20, glyph: 120, probe: 40,
  proportional: false,
  labelMinPx: Infinity, countMinPx: Infinity, glyphMinPx: 34,
};

export const rowTop = (m: OrtoMetrics, i: number) =>
  m.pad + m.labelH + i * (m.rowH + m.gap + m.labelH);

export const totalHeight = (m: OrtoMetrics, rows: number) =>
  m.pad * 2 + rows * (m.rowH + m.labelH) + Math.max(0, rows - 1) * m.gap;

/** Baseline dell'etichetta di fila, sopra la riga. */
export const rowLabelY = (m: OrtoMetrics, top: number) => top - m.labelH * 0.3;

/** Banda superiore: i pin. */
export const pinY = (m: OrtoMetrics, top: number) => top + m.rowH * 0.24;

/** Banda inferiore: i timbri coltura (baseline del testo). */
export const stampY = (m: OrtoMetrics, top: number) => top + m.rowH * 0.8;

/** Di quanto scende un'etichetta pin sfalsata per non pestare la precedente. */
export const flipOffset = (m: OrtoMetrics) => m.fsValue * 1.15;

/** Semiampiezza verticale di un testo, alone `paint-order` incluso. */
export const labelHalf = (fs: number) => fs * 0.55 + 2;

export const glyphTop = (m: OrtoMetrics, baseline: number) => baseline - m.glyph * 0.62;

/** Stima grossolana della larghezza di un testo: serve solo a decidere se una
 *  cosa ci sta, non a posizionarla. */
export const textW = (s: string, fs: number) => s.length * fs * 0.58;

/**
 * Ascissa di partenza dell'etichetta di una sonda, garantita dentro `[0, rowW]`.
 *
 * Preferisce la destra della sonda; se sfora il bordo passa a sinistra; se non
 * ci sta da nessuna delle due parti (riga strettissima) si aggrappa al bordo.
 * L'etichetta di WH51_02, a 0.866 di una fila lunga 830 unità, sforava di 6.
 */
export function labelX(cx: number, labelW: number, rowW: number, gap: number): number {
  const destra = cx + gap;
  if (destra + labelW <= rowW) return destra;
  const sinistra = cx - gap - labelW;
  if (sinistra >= 0) return sinistra;
  return Math.max(0, Math.min(destra, rowW - labelW));
}

/** Tiene il glifo sonda dentro la riga anche con x agli estremi. */
export const clampProbe = (cx: number, probe: number, rowW: number) =>
  Math.max(probe / 2, Math.min(cx, rowW - probe / 2));
