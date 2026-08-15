import { useRef, useState } from 'react';
import type { Layout } from '../api/types';
import { CROPS, rowLength } from '../config/orto';
import {
  addArea, addSensor, areaFrom, canAddArea, canRemoveArea, removeArea, reorderArea, setCrop,
} from '../helpers/layoutOps';
import { rowLabelY, rowTop, totalHeight, type OrtoMetrics } from '../helpers/ortoMetrics';

/** Valore speciale della tendina `+ sonda`: apre la finestra dei rilevati. */
export const NUOVO_SENSORE = '__nuovo__';

interface Props {
  layout: Layout;
  m: OrtoMetrics;
  onChange: (l: Layout) => void;
  /** Sonde registrate e non ancora piazzate (dal registro, step 14). */
  libere: string[];
  onNuovoSensore: (fila: number) => void;
}

/** Sotto questa larghezza (unità viewBox) il menu a tendina non ci sta. */
const MIN_PER_TENDINA = 130;

/**
 * Controlli dell'editor: HTML vero sovrapposto all'SVG, non `<foreignObject>`.
 *
 * Il motivo è che l'SVG ha un viewBox che scala con la larghezza: dentro un
 * foreignObject un `<select>` verrebbe scalato insieme al disegno, e a schermo
 * grande diventerebbe enorme. Posizionando i controlli in percentuale sopra la
 * mappa restano di dimensione naturale, e la geometria resta comunque una sola.
 */
export function OrtoOverlay({ layout, m, onChange, libere, onNuovoSensore }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [trascinata, setTrascinata] = useState<{ fila: number; i: number } | null>(null);

  const totalH = totalHeight(m, layout.file.length);
  const pctX = (vbX: number) => ((vbX + m.pad) / (m.vw + m.pad * 2)) * 100;
  const pctY = (vbY: number) => (vbY / totalH) * 100;

  /** Da coordinate schermo a x nel viewBox. */
  const vbFromClient = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return 0;
    return ((clientX - r.left) / r.width) * (m.vw + m.pad * 2) - m.pad;
  };

  return (
    <div className="orto-overlay" ref={ref}>
      {layout.file.map((row, i) => {
        const w = (m.proportional ? rowLength(row.id) : 1) * m.vw;
        const y = rowTop(m, i);

        return (
          <div key={row.id}>
            <div
              className="ov-rowbar"
              style={{ left: `${pctX(w)}%`, top: `${pctY(rowLabelY(m, y))}%` }}
            >
              <button
                type="button"
                className="ov-btn ov-add"
                disabled={!canAddArea(row)}
                title={canAddArea(row) ? 'Aggiungi un’area in fondo a destra' : 'Massimo 5 aree per fila'}
                onClick={() => onChange(addArea(layout, row.id))}
              >
                + area
              </button>
              <select
                className="ov-btn ov-add ov-add-sonda"
                value=""
                title={`Piazza una sonda in fila ${row.id}, o registrane una nuova`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  if (v === NUOVO_SENSORE) return onNuovoSensore(row.id);
                  // 0.5 è solo il punto di partenza: addSensor scosta se trova
                  // un'altra sonda troppo vicina.
                  onChange(addSensor(layout, row.id, v, 0.5));
                }}
              >
                <option value="">+ sonda</option>
                {libere.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
                <option value={NUOVO_SENSORE}>＋ nuovo sensore…</option>
              </select>
            </div>

            {row.aree.map((a, j) => {
              const from = areaFrom(row, j);
              const larghezza = (a.to - from) * w;
              const x0 = from * w;
              const x1 = a.to * w;
              const cx = (x0 + x1) / 2;
              const inMovimento = trascinata?.fila === row.id && trascinata.i === j;

              return (
                <div key={j} className={inMovimento ? 'ov-area dragging' : 'ov-area'}>
                  <button
                    type="button"
                    className="ov-btn ov-del"
                    style={{ left: `${pctX(x0)}%`, top: `${pctY(y)}%` }}
                    disabled={!canRemoveArea(row)}
                    title={canRemoveArea(row) ? 'Elimina l’area' : 'Una fila deve avere almeno un’area'}
                    onClick={() => onChange(removeArea(layout, row.id, j))}
                  >
                    ✕
                  </button>

                  <button
                    type="button"
                    className="ov-btn ov-grip"
                    style={{ left: `${pctX(x1)}%`, top: `${pctY(y)}%` }}
                    title="Trascina per cambiare ordine"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      (e.currentTarget as Element).setPointerCapture(e.pointerId);
                      let corrente = j;
                      let vivo = layout;
                      setTrascinata({ fila: row.id, i: j });

                      const muovi = (ev: PointerEvent) => {
                        const r = vivo.file.find((f) => f.id === row.id)!;
                        const frazione = Math.max(0, Math.min(1, vbFromClient(ev.clientX) / w));
                        // Indice sotto il puntatore, con le larghezze correnti.
                        let acc = 0;
                        let sopra = r.aree.length - 1;
                        for (let k = 0; k < r.aree.length; k++) {
                          acc = r.aree[k].to;
                          if (frazione < acc) { sopra = k; break; }
                        }
                        if (sopra !== corrente) {
                          vivo = reorderArea(vivo, row.id, corrente, sopra);
                          corrente = sopra;
                          onChange(vivo);
                          setTrascinata({ fila: row.id, i: corrente });
                        }
                      };
                      const su = () => {
                        window.removeEventListener('pointermove', muovi);
                        window.removeEventListener('pointerup', su);
                        setTrascinata(null);
                      };
                      window.addEventListener('pointermove', muovi);
                      window.addEventListener('pointerup', su);
                    }}
                  >
                    ⠿
                  </button>

                  {larghezza >= MIN_PER_TENDINA && (
                    <select
                      className="ov-crop"
                      style={{ left: `${pctX(cx)}%`, top: `${pctY(y + m.rowH * 0.42)}%` }}
                      value={a.crop}
                      title="Coltura di quest’area"
                      onChange={(e) => onChange(setCrop(layout, row.id, j, e.target.value))}
                    >
                      {Object.keys(CROPS).map((k) => (
                        <option key={k} value={k}>{CROPS[k].label}</option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
