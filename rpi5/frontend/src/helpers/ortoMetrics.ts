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
  /** Lato del riquadro in cui sta il glifo coltura. */
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
  vw: 1150, rowH: 132, gap: 22, pad: 14, labelH: 30,
  fsValue: 22, fsSmall: 13, fsLabel: 13, glyph: 44, probe: 26,
  proportional: true,
  labelMinPx: 150, countMinPx: 80, glyphMinPx: 34,
};

// Su mobile: file tutte uguali, e nel timbro resta il solo glifo.
export const MOBILE: OrtoMetrics = {
  vw: 1000, rowH: 260, gap: 26, pad: 16, labelH: 46,
  fsValue: 34, fsSmall: 20, fsLabel: 20, glyph: 76, probe: 40,
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
