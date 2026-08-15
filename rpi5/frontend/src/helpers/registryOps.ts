/**
 * Operazioni pure sul registro dei sensori. Nessun React, così un test le
 * raggiunge (`registryOps.test.ts`). Rispecchiano la validazione server-side,
 * che resta comunque quella autoritativa.
 */
import type { RegistrySensor } from '../api/registry.ts';

export const MAX_CANALI = 8;
export const MAX_LABEL = 60;

export interface RegistryError {
  path: string;
  code: string;
  message: string;
}

/** Il canale decide l'id solo alla registrazione; dopo l'id è congelato e il
 *  canale può cambiare senza spezzare lo storico (step 14, D5). */
export function idPerCanale(channel: number): string {
  return `WH51_${String(channel).padStart(2, '0')}`;
}

/** Se l'id derivato dal canale è già preso, si cerca il primo libero: può
 *  succedere dopo un ri-aggancio, quando id e canale non coincidono più. */
export function nuovoId(sensori: RegistrySensor[], channel: number): string {
  const presi = new Set(sensori.map((s) => s.sensor_id));
  const naturale = idPerCanale(channel);
  if (!presi.has(naturale)) return naturale;
  for (let i = 1; i <= 99; i++) {
    const alt = idPerCanale(i);
    if (!presi.has(alt)) return alt;
  }
  return naturale;
}

export function registra(
  sensori: RegistrySensor[],
  channel: number,
  label = '',
): RegistrySensor[] {
  if (sensori.some((s) => s.channel === channel)) return sensori;
  return [
    ...sensori,
    {
      sensor_id: nuovoId(sensori, channel),
      channel,
      label,
      registered_at: Math.floor(Date.now() / 1000),
      placement: null,
      gateway: null,
    },
  ];
}

export function deregistra(sensori: RegistrySensor[], sensorId: string): RegistrySensor[] {
  return sensori.filter((s) => s.sensor_id !== sensorId);
}

export function rinomina(
  sensori: RegistrySensor[],
  sensorId: string,
  label: string,
): RegistrySensor[] {
  return sensori.map((s) => (s.sensor_id === sensorId ? { ...s, label } : s));
}

export function puoDeregistrare(s: RegistrySensor): boolean {
  return s.placement === null;
}

export function validaRegistro(sensori: RegistrySensor[]): RegistryError[] {
  const e: RegistryError[] = [];
  const add = (path: string, code: string, message: string) => e.push({ path, code, message });
  const visti = new Map<string, number>();
  const canali = new Map<number, string>();

  sensori.forEach((s, i) => {
    const p = `sensori[${i}]`;
    if (!/^WH51_\d\d$/.test(s.sensor_id)) {
      add(`${p}.sensor_id`, 'bad_sensor_id', `id non conforme: ${s.sensor_id}`);
    } else if (visti.has(s.sensor_id)) {
      add(`${p}.sensor_id`, 'duplicate_sensor_id', `${s.sensor_id} compare due volte`);
    } else visti.set(s.sensor_id, i);

    if (!Number.isInteger(s.channel) || s.channel < 1 || s.channel > MAX_CANALI) {
      add(`${p}.channel`, 'bad_channel', `canale fra 1 e ${MAX_CANALI}`);
    } else if (canali.has(s.channel)) {
      add(`${p}.channel`, 'duplicate_channel', `canale ${s.channel} già assegnato a ${canali.get(s.channel)}`);
    } else canali.set(s.channel, s.sensor_id);

    if (typeof s.label !== 'string' || s.label.length > MAX_LABEL) {
      add(`${p}.label`, 'bad_label', `etichetta di al massimo ${MAX_LABEL} caratteri`);
    }
  });
  return e;
}
