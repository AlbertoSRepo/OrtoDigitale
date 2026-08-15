/**
 * Operazioni sul layout dell'orto — funzioni pure, nessun React.
 *
 * Stanno fuori dal componente per due ragioni: sono la sola logica non banale
 * dell'editor, e qui un test le raggiunge (`layoutOps.test.ts`). Ogni funzione
 * restituisce un layout nuovo e non tocca quello in ingresso.
 *
 * Le invarianti sono quelle di docs/step12 §5.3, ripetute server-side in
 * `PUT /api/layout`: qui servono a dare riscontro immediato, non a proteggere
 * il dato — di quello risponde il backend.
 */
import type { Layout, LayoutArea, LayoutRow } from '../api/types.ts';
import { CROPS } from '../config/orto.ts';

export const MIN_AREA = 0.05;
export const MIN_DIST = 0.03;
export const MAX_AREE = 5;
export const MAX_PIANTE = 20;

export interface ValidationError {
  path: string;
  code: string;
  message: string;
}

const clone = (l: Layout): Layout => JSON.parse(JSON.stringify(l));
const idx = (l: Layout, fila: number) => l.file.findIndex((r) => r.id === fila);

/** Bordo sinistro di un'area: il `to` della precedente (step 12, §5.2). */
export function areaFrom(row: LayoutRow, i: number): number {
  return i === 0 ? 0 : row.aree[i - 1].to;
}

/** Indice dell'area che contiene la frazione `at`. */
export function areaAt(row: LayoutRow, at: number): number {
  const i = row.aree.findIndex((a) => at < a.to);
  return i === -1 ? row.aree.length - 1 : i;
}

// --- aree -------------------------------------------------------------------

export function canSplit(row: LayoutRow, at: number): boolean {
  if (row.aree.length >= MAX_AREE) return false;
  const i = areaAt(row, at);
  return at - areaFrom(row, i) >= MIN_AREA && row.aree[i].to - at >= MIN_AREA;
}

/** Divide l'area sotto `at`. La parte destra eredita la coltura, e le piante si
 *  ripartiscono in proporzione alla larghezza. */
export function splitArea(l: Layout, fila: number, at: number): Layout {
  const out = clone(l);
  const row = out.file[idx(out, fila)];
  if (!canSplit(row, at)) return l;
  const i = areaAt(row, at);
  const a = row.aree[i];
  const from = areaFrom(row, i);
  const quota = (at - from) / (a.to - from);
  const sinistra = Math.round(a.n * quota);
  const nuova: LayoutArea = { crop: a.crop, to: a.to, n: a.n - sinistra };
  row.aree[i] = { crop: a.crop, to: at, n: sinistra };
  row.aree.splice(i + 1, 0, nuova);
  return out;
}

/** Elimina il confine e tiene la coltura dell'area su cui si è agito. */
export function mergeArea(l: Layout, fila: number, i: number, dir: 'left' | 'right'): Layout {
  const out = clone(l);
  const row = out.file[idx(out, fila)];
  const j = dir === 'left' ? i - 1 : i + 1;
  if (j < 0 || j >= row.aree.length) return l;
  const [lo, hi] = i < j ? [i, j] : [j, i];
  const tenuta = row.aree[i];
  const fusa: LayoutArea = {
    crop: tenuta.crop,
    to: row.aree[hi].to,
    n: tenuta.crop === 'libero' ? 0 : row.aree[lo].n + row.aree[hi].n,
  };
  row.aree.splice(lo, 2, fusa);
  return out;
}

export function setCrop(l: Layout, fila: number, i: number, crop: string): Layout {
  const out = clone(l);
  const a = out.file[idx(out, fila)].aree[i];
  a.crop = crop;
  if (crop === 'libero') a.n = 0;
  else if (a.n === 0) a.n = 1;
  return out;
}

export function setPlantCount(l: Layout, fila: number, i: number, n: number): Layout {
  const out = clone(l);
  const a = out.file[idx(out, fila)].aree[i];
  if (a.crop === 'libero') return l;
  a.n = Math.max(0, Math.min(MAX_PIANTE, n));
  return out;
}

/** Sposta il confine `i` (fra l'area i e la i+1). Entrambe le adiacenti cambiano,
 *  la somma resta 1.0: è il divisorio di finestra, non un bordo indipendente. */
export function moveDivider(l: Layout, fila: number, i: number, to: number): Layout {
  const out = clone(l);
  const row = out.file[idx(out, fila)];
  if (i < 0 || i >= row.aree.length - 1) return l;
  const min = areaFrom(row, i) + MIN_AREA;
  const max = row.aree[i + 1].to - MIN_AREA;
  if (max < min) return l;
  row.aree[i].to = Math.max(min, Math.min(max, to));
  return out;
}

// --- sonde ------------------------------------------------------------------

export function placedSensors(l: Layout): Map<string, { fila: number; x: number }> {
  const m = new Map<string, { fila: number; x: number }>();
  for (const row of l.file) for (const s of row.sensori) m.set(s.sensor_id, { fila: row.id, x: s.x });
  return m;
}

/** Tiene la sonda dentro [0,1] e a distanza dalle sorelle della stessa fila. */
function clampX(row: LayoutRow, sensorId: string, x: number): number {
  const altre = row.sensori.filter((s) => s.sensor_id !== sensorId).map((s) => s.x).sort((a, b) => a - b);
  let v = Math.max(0, Math.min(1, x));
  for (const o of altre) {
    if (Math.abs(v - o) < MIN_DIST) v = v < o ? o - MIN_DIST : o + MIN_DIST;
  }
  return Math.max(0, Math.min(1, v));
}

export function addSensor(l: Layout, fila: number, sensorId: string, x: number): Layout {
  const out = removeSensor(l, sensorId);
  const row = out.file[idx(out, fila)];
  row.sensori.push({ sensor_id: sensorId, x: clampX(row, sensorId, x) });
  row.sensori.sort((a, b) => a.x - b.x);
  return out;
}

export function moveSensor(l: Layout, sensorId: string, fila: number, x: number): Layout {
  const attuale = placedSensors(l).get(sensorId);
  if (attuale && attuale.fila === fila) {
    const out = clone(l);
    const row = out.file[idx(out, fila)];
    const s = row.sensori.find((v) => v.sensor_id === sensorId)!;
    s.x = clampX(row, sensorId, x);
    row.sensori.sort((a, b) => a.x - b.x);
    return out;
  }
  return addSensor(l, fila, sensorId, x);
}

/** Sostituisce la sonda mantenendone la posizione. */
export function changeSensor(l: Layout, from: string, to: string): Layout {
  const pos = placedSensors(l).get(from);
  if (!pos) return l;
  return addSensor(removeSensor(l, from), pos.fila, to, pos.x);
}

export function removeSensor(l: Layout, sensorId: string): Layout {
  const out = clone(l);
  for (const row of out.file) row.sensori = row.sensori.filter((s) => s.sensor_id !== sensorId);
  return out;
}

// --- validazione ------------------------------------------------------------

export function validateLayout(l: Layout): ValidationError[] {
  const e: ValidationError[] = [];
  const add = (path: string, code: string, message: string) => e.push({ path, code, message });

  if (!l || !Array.isArray(l.file) || l.file.length !== 3) {
    add('file', 'bad_file_set', 'servono esattamente 3 file');
    return e;
  }

  const visti = new Map<string, number>();
  l.file.forEach((row, i) => {
    if (row.aree.length < 1 || row.aree.length > MAX_AREE) {
      add(`file[${i}].aree`, 'too_many_areas', `una fila ha da 1 a ${MAX_AREE} aree`);
    }
    let prev = 0;
    row.aree.forEach((a, j) => {
      const p = `file[${i}].aree[${j}]`;
      if (!(a.to > prev)) add(`${p}.to`, 'not_increasing', 'i confini devono crescere');
      else if (a.to - prev < MIN_AREA - 1e-9) add(`${p}.to`, 'area_too_narrow', 'area troppo stretta');
      if (!CROPS[a.crop]) add(`${p}.crop`, 'unknown_crop', `coltura sconosciuta: ${a.crop}`);
      if (!Number.isInteger(a.n) || a.n < 0 || a.n > MAX_PIANTE || (a.crop === 'libero' && a.n !== 0)) {
        add(`${p}.n`, 'bad_plant_count', `piante fra 0 e ${MAX_PIANTE}, e 0 per libero`);
      }
      prev = a.to;
    });
    if (Math.abs(prev - 1) > 1e-6) {
      add(`file[${i}].aree[${row.aree.length - 1}].to`, 'not_closed', "l'ultima area deve chiudere a 1");
    }

    const ordinate = [...row.sensori].sort((a, b) => a.x - b.x);
    ordinate.forEach((s, j) => {
      const p = `file[${i}].sensori[${j}]`;
      if (visti.has(s.sensor_id)) {
        add(`${p}.sensor_id`, 'duplicate_sensor', `${s.sensor_id} è già in fila ${visti.get(s.sensor_id)}`);
      } else visti.set(s.sensor_id, row.id);
      if (!(s.x >= 0 && s.x <= 1)) add(`${p}.x`, 'x_out_of_range', 'posizione fuori dalla fila');
      if (j > 0 && s.x - ordinate[j - 1].x < MIN_DIST - 1e-9) {
        add(`${p}.x`, 'sensor_too_close', 'sonde troppo vicine fra loro');
      }
    });
  });
  return e;
}
