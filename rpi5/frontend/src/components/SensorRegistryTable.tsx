import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { putRegistry, useRegistry, type RegistrySensor } from '../api/registry';
import { deregistra, puoDeregistrare, rinomina } from '../helpers/registryOps';

/**
 * Anagrafica dei sensori registrati, per la pagina Impostazioni.
 *
 * La colonna «dove» non è memorizzata da nessuna parte: il server la deriva
 * dal layout (step 14, D2). Se dice «libera», quella sonda non è su nessuna
 * fila — ed è l'unica condizione in cui si può deregistrare.
 */
export function SensorRegistryTable() {
  const qc = useQueryClient();
  const { data, isLoading } = useRegistry();
  const [inCorso, setInCorso] = useState<string | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [bozzaLabel, setBozzaLabel] = useState<Record<string, string>>({});

  async function salva(sensori: RegistrySensor[], chi: string) {
    setInCorso(chi);
    setErrore(null);
    try {
      const salvato = await putRegistry(sensori);
      qc.setQueryData(['sensors', 'registry'], salvato);
      await qc.invalidateQueries({ queryKey: ['sensors', 'registry'] });
    } catch (e) {
      const corpo = e instanceof Error && 'body' in e ? String((e as { body: unknown }).body) : String(e);
      let testo = corpo;
      try {
        const j = JSON.parse(corpo);
        if (j.errors) testo = j.errors.map((x: { message: string }) => x.message).join(' · ');
      } catch { /* corpo non JSON */ }
      setErrore(testo.slice(0, 300));
    } finally {
      setInCorso(null);
    }
  }

  if (isLoading) return <p className="orto-avviso">Carico il registro…</p>;
  const sensori = data?.sensori ?? [];

  return (
    <>
      {errore && <p className="orto-avviso errore">{errore}</p>}
      {data && data.rilevati.length > 0 && (
        <p className="orto-avviso">
          {data.rilevati.length === 1 ? 'Un sensore rilevato' : `${data.rilevati.length} sensori rilevati`}
          {' '}dal gateway e non ancora registrato
          {data.rilevati.length === 1 ? '' : 'i'}: canale{data.rilevati.length === 1 ? '' : 'i'}{' '}
          {data.rilevati.map((r) => r.channel).join(', ')}. Si registrano dalla mappa, con «＋ nuovo sensore…».
        </p>
      )}

      <table className="tab-registro">
        <thead>
          <tr>
            <th>sensore</th>
            <th>canale</th>
            <th>etichetta</th>
            <th>dove</th>
            <th>gateway</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sensori.map((s) => {
            const libera = puoDeregistrare(s);
            const label = bozzaLabel[s.sensor_id] ?? s.label;
            return (
              <tr key={s.sensor_id}>
                <td className="mono">{s.sensor_id}</td>
                <td className="tabular">{s.channel}</td>
                <td>
                  <input
                    className="ov-crop"
                    style={{ position: 'static', transform: 'none', maxWidth: 180 }}
                    value={label}
                    maxLength={60}
                    placeholder="—"
                    disabled={inCorso !== null}
                    onChange={(e) => setBozzaLabel({ ...bozzaLabel, [s.sensor_id]: e.target.value })}
                    onBlur={() => {
                      if (label !== s.label) salva(rinomina(sensori, s.sensor_id, label), s.sensor_id);
                    }}
                  />
                </td>
                <td className={libera ? 'libera' : 'tabular'}>
                  {libera ? 'libera' : `fila ${s.placement!.fila} · ${Math.round(s.placement!.x * 100)}%`}
                </td>
                <td className="tabular">
                  {s.gateway
                    ? `${s.gateway.moisture}% · ${s.gateway.battery_v?.toFixed(1) ?? '—'} V · ${s.gateway.seen_seconds_ago}s fa`
                    : 'non rilevata'}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    disabled={!libera || inCorso !== null}
                    title={
                      libera
                        ? `Cancella ${s.sensor_id} dal registro: smetterà di essere scritto su InfluxDB`
                        : 'Toglila prima dalla mappa: è ancora piazzata'
                    }
                    onClick={() => salva(deregistra(sensori, s.sensor_id), s.sensor_id)}
                  >
                    {inCorso === s.sensor_id ? '…' : 'Deregistra'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="eyebrow" style={{ marginTop: 10 }}>
        solo i sensori registrati vengono scritti su InfluxDB e conteggiati dall’irrigazione
      </p>
    </>
  );
}
