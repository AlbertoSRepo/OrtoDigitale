/**
 * Zone di umidità di una fila, derivate dalla posizione dei misuratori.
 *
 * Ogni sonda governa il tratto che le sta più vicino: i confini cadono a metà
 * strada fra due sonde consecutive, e le due estremità si estendono ai bordi
 * della fila. Le zone non hanno niente a che vedere con le aree coltura —
 * sono due livelli indipendenti (step 12, D5).
 */

export interface BandInput {
  sensor_id: string;
  x: number;
}

export interface Band {
  sensor_id: string;
  from: number;
  to: number;
}

export function moistureBands(sensori: readonly BandInput[]): Band[] {
  const s = [...sensori].sort((a, b) => a.x - b.x);
  return s.map((cur, i) => ({
    sensor_id: cur.sensor_id,
    from: i === 0 ? 0 : (s[i - 1].x + cur.x) / 2,
    to: i === s.length - 1 ? 1 : (cur.x + s[i + 1].x) / 2,
  }));
}
