// Coordinate normalizzate (0-1) dei 6 sensori sull'ortofoto.
// Riprese dal prototipo orto-digitale-design/project/data.js.

export interface SensorCoord {
  x: number;
  y: number;
}

export const SENSOR_COORDS: Record<string, SensorCoord> = {
  WH51_01: { x: 0.355, y: 0.255 },
  WH51_02: { x: 0.715, y: 0.235 },
  WH51_03: { x: 0.345, y: 0.475 },
  WH51_04: { x: 0.700, y: 0.460 },
  WH51_05: { x: 0.345, y: 0.715 },
  WH51_06: { x: 0.690, y: 0.700 },
};

export interface AiuolaGuide {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const AIUOLE: AiuolaGuide[] = [
  { id: 1, x: 0.295, y: 0.165, w: 0.485, h: 0.135 },
  { id: 2, x: 0.295, y: 0.395, w: 0.485, h: 0.135 },
  { id: 3, x: 0.295, y: 0.625, w: 0.485, h: 0.135 },
];

// Mapping sensor_id -> aiuola/position di default (CLAUDE.md sensor mapping).
export const SENSOR_LOCATIONS: Record<string, { aiuola: number; position: 'near' | 'far' }> = {
  WH51_01: { aiuola: 1, position: 'near' },
  WH51_02: { aiuola: 1, position: 'far' },
  WH51_03: { aiuola: 2, position: 'near' },
  WH51_04: { aiuola: 2, position: 'far' },
  WH51_05: { aiuola: 3, position: 'near' },
  WH51_06: { aiuola: 3, position: 'far' },
};

// Sensori fisicamente installati (gli altri sono mostrati grigi).
export const ACTIVE_SENSORS = new Set(['WH51_01', 'WH51_02', 'WH51_03', 'WH51_04']);
