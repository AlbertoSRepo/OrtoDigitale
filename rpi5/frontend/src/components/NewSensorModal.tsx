import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { putRegistry, useRegistry, type DetectedChannel } from '../api/registry';
import { registra } from '../helpers/registryOps';

interface Props {
  /** Fila su cui è stato aperto: la sonda registrata viene piazzata qui. */
  fila: number;
  onClose: () => void;
  onRegistrato: (sensorId: string) => void;
}

/**
 * Finestra dei sensori **rilevati dal gateway e non ancora registrati**.
 *
 * I registrati non compaiono qui: la loro anagrafica sta in Impostazioni.
 * Questa finestra serve un gesto solo — «ne ho appena accoppiato uno, mettilo
 * in questa fila» — e registrare da qui piazza anche, perché è ciò che
 * l'utente stava già facendo quando l'ha aperta.
 */
export function NewSensorModal({ fila, onClose, onRegistrato }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useRegistry();
  const [inCorso, setInCorso] = useState<number | null>(null);
  const [errore, setErrore] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const rilevati = data?.rilevati ?? [];

  async function registraCanale(c: DetectedChannel) {
    if (!data) return;
    setInCorso(c.channel);
    setErrore(null);
    try {
      const aggiornato = registra(data.sensori, c.channel);
      const nuovo = aggiornato[aggiornato.length - 1];
      const salvato = await putRegistry(aggiornato);
      qc.setQueryData(['sensors', 'registry'], salvato);
      await qc.invalidateQueries({ queryKey: ['sensors', 'registry'] });
      onRegistrato(nuovo.sensor_id);
      onClose();
    } catch (e) {
      setErrore(e instanceof Error ? e.message : String(e));
    } finally {
      setInCorso(null);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h3>Sensori rilevati</h3>
          <span className="eyebrow">non ancora registrati · fila {fila}</span>
        </div>

        {isLoading && <p className="orto-avviso">Interrogo il gateway…</p>}

        {!isLoading && rilevati.length === 0 && (
          <p className="orto-avviso">
            Nessun sensore nuovo. Il GW3000 pubblica ogni 60 secondi: se hai appena accoppiato
            una sonda, comparirà entro un minuto. I sensori già registrati stanno in Impostazioni.
          </p>
        )}

        {errore && <p className="orto-avviso errore">Registrazione fallita: {errore}</p>}

        {rilevati.length > 0 && (
          <table className="tab-registro">
            <thead>
              <tr>
                <th>canale</th>
                <th>umidità</th>
                <th>batteria</th>
                <th>visto</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rilevati.map((c) => (
                <tr key={c.channel}>
                  <td className="mono">{c.channel}</td>
                  <td className="tabular">{c.moisture}%</td>
                  <td className="tabular">{c.battery_v !== null ? `${c.battery_v.toFixed(1)} V` : '—'}</td>
                  <td className="tabular">{c.seen_seconds_ago}s fa</td>
                  <td>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={inCorso !== null}
                      onClick={() => registraCanale(c)}
                    >
                      {inCorso === c.channel ? 'Registro…' : 'Registra e piazza'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Chiudi</button>
        </div>
      </div>
    </div>
  );
}
