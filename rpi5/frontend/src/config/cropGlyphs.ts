// Caricamento dei glifi coltura. Sta a parte da config/orto.ts perche' usa
// import.meta.glob, sintassi che esiste solo sotto Vite: tenendola qui, la
// config resta caricabile da `node --test` insieme a layoutOps.

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
