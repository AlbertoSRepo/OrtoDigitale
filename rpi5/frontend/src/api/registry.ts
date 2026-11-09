import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPut } from './client';

/** Riga del registro. `hw_id`, `placement` e `gateway` sono derivati dal
 *  server: si leggono e basta, il PUT li ignora (step 14, D2). */
export interface RegistrySensor {
  sensor_id: string;
  channel: number;
  label: string;
  registered_at: number;
  /** Id stampato sulla sonda, letto dal GW3000 (step 18). `null` se il
   *  gateway non risponde: è una vista, non un dato memorizzato. */
  hw_id: string | null;
  placement: { fila: number; x: number } | null;
  gateway: { seen_seconds_ago: number; moisture: number; battery_v: number | null } | null;
}

export interface DetectedChannel {
  channel: number;
  hw_id: string | null;
  seen_seconds_ago: number;
  moisture: number;
  battery_v: number | null;
}

export interface Registry {
  version: number;
  updated_at: number;
  sensori: RegistrySensor[];
  /** Canali visti al gateway e non ancora registrati. */
  rilevati: DetectedChannel[];
}

/** Anagrafica: cambia di rado. Ma `rilevati` e `gateway` invecchiano, e una
 *  sonda appena accoppiata deve comparire senza ricaricare la pagina. */
export function useRegistry() {
  return useQuery({
    queryKey: ['sensors', 'registry'],
    queryFn: () => apiGet<Registry>('/sensors/registry'),
    refetchInterval: 30_000,
  });
}

export function putRegistry(sensori: RegistrySensor[]) {
  return apiPut<Registry>('/sensors/registry', {
    version: 1,
    sensori: sensori.map((s) => ({
      sensor_id: s.sensor_id,
      channel: s.channel,
      label: s.label,
      registered_at: s.registered_at,
    })),
  });
}
