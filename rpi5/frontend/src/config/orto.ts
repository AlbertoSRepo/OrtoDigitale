// Geometria dell'orto e catalogo colture — vedi docs/step12_vista_orto_schematica.md
//
// Le lunghezze sono frazioni della fila più lunga (fila 3), ricavate misurando
// example.png. L'altezza di riga NON sta qui: è una metrica responsive, decisa
// dal componente (step 12, D6).

export const FILE_GEOM = [
  { id: 1, length: 0.722 },
  { id: 2, length: 0.790 },
  { id: 3, length: 1.0 },
] as const;

export type FilaId = (typeof FILE_GEOM)[number]['id'];

export function rowLength(id: number): number {
  return FILE_GEOM.find((f) => f.id === id)?.length ?? 1;
}

// --- Colture ---------------------------------------------------------------

export interface Crop {
  label: string;
  /** null = nessuna tinta e nessun glifo: si disegna come terreno nudo. */
  color: string | null;
}

export const CROPS: Record<string, Crop> = {
  libero: { label: 'libero', color: null },
  pomodoro: { label: 'pomodoro', color: 'var(--terra)' },
  zucchina: { label: 'zucchina', color: 'var(--moss)' },
  melanzana: { label: 'melanzana', color: 'var(--aubergine)' },
  lattuga: { label: 'lattuga', color: 'var(--leaf)' },
};

export function crop(key: string): Crop {
  return CROPS[key] ?? { label: key, color: 'var(--ink-3)' };
}

// --- Glifi -----------------------------------------------------------------
// I file forniti in svg/ erano PNG 612x408 in base64 avvolti in un <pattern>:
// stesso foglio quattro volte, 165 KB l'uno. Sono stati ritagliati in quattro
// PNG (vedi docs/step12 §6.3), che Vite serve come asset statici — quindi non
// finiscono nel bundle JS e il service worker li precachea.
// Sono illustrazioni a colori: NON si tingono, a differenza del glifo sonda.

const GLYPHS = import.meta.glob('../assets/crops/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const BY_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(GLYPHS).map(([path, url]) => [path.split('/').pop()!.replace('.png', ''), url]),
);

/** URL del glifo, o null se per quella coltura non e' stato fornito un file. */
export function cropGlyph(key: string): string | null {
  return BY_KEY[key] ?? null;
}
