import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { putLayout } from '../api/layout';
import type { Layout } from '../api/types';
import { SENSOR_LOCATIONS } from '../config/sensors';
import { useRegistry } from '../api/registry';
import { addSensor, placedSensors, removeSensor, validateLayout } from '../helpers/layoutOps';
import { useMediaQuery } from '../helpers/useMediaQuery';
import { NewSensorModal } from './NewSensorModal';
import { OrtoMap } from './OrtoMap';

interface Props {
  layout: Layout | undefined;
  sensors: Parameters<typeof OrtoMap>[0]['sensors'];
  thresholds: Parameters<typeof OrtoMap>[0]['thresholds'];
  activeSensor: string | null;
  onSelectSensor: (id: string | null) => void;
}

/**
 * Involucro editor attorno alla mappa: tiene la bozza e salva. I controlli
 * delle aree stanno sulla mappa stessa (OrtoOverlay); qui restano la barra,
 * gli avvisi e la gestione delle sonde.
 */
export function OrtoEditor({ layout, sensors, thresholds, activeSensor, onSelectSensor }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Layout | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroreServer, setErroreServer] = useState<string | null>(null);
  const [nuovoSuFila, setNuovoSuFila] = useState<number | null>(null);
  const registro = useRegistry();

  // L'editor è desktop-only: serve un puntatore fine e spazio (step 13, §3).
  const editabile = useMediaQuery('(min-width: 900px)') && useMediaQuery('(pointer: fine)');

  const vista = editing && draft ? draft : layout;
  const dirty = !!draft && !!layout && JSON.stringify(draft) !== JSON.stringify(layout);
  const errori = useMemo(() => (draft ? validateLayout(draft) : []), [draft]);

  const piazzate = useMemo(() => (draft ? placedSensors(draft) : new Map()), [draft]);
  // Le sonde piazzabili sono quelle REGISTRATE e non ancora sulla mappa: non
  // piu' una costante nel codice (step 14, D8).
  const libereSonde = useMemo(
    () => (registro.data?.sensori ?? []).map((s) => s.sensor_id).filter((id) => !piazzate.has(id)).sort(),
    [registro.data, piazzate],
  );
  // Se una sonda finisce in una fila diversa dalla sua aiuola di targa, le
  // nuove letture verranno registrate con la fila nuova (step 13, §9).
  const riassegnate = useMemo(
    () =>
      [...piazzate.entries()]
        .filter(([id, p]) => SENSOR_LOCATIONS[id] && SENSOR_LOCATIONS[id].aiuola !== p.fila)
        .map(([id, p]) => ({ id, da: SENSOR_LOCATIONS[id].aiuola, a: p.fila })),
    [piazzate],
  );

  useEffect(() => {
    if (!dirty) return;
    const guardia = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', guardia);
    return () => window.removeEventListener('beforeunload', guardia);
  }, [dirty]);

  const apri = useCallback(() => {
    if (!layout) return;
    setDraft(JSON.parse(JSON.stringify(layout)));
    setErroreServer(null);
    setEditing(true);
  }, [layout]);

  const annulla = useCallback(() => {
    setDraft(null);
    setErroreServer(null);
    setEditing(false);
  }, []);

  const salva = useCallback(async () => {
    if (!draft) return;
    setSalvando(true);
    setErroreServer(null);
    try {
      const salvato = await putLayout(draft);
      qc.setQueryData(['layout'], salvato);
      await qc.invalidateQueries({ queryKey: ['layout'] });
      setDraft(null);
      setEditing(false);
    } catch (e) {
      // Il 400 del server porta i codici; la bozza NON va persa.
      const corpo = e instanceof Error && 'body' in e ? String((e as { body: unknown }).body) : String(e);
      let testo = corpo;
      try {
        const j = JSON.parse(corpo);
        if (j.errors) testo = j.errors.map((x: { message: string }) => x.message).join(' · ');
      } catch { /* corpo non JSON: si mostra grezzo */ }
      setErroreServer(testo.slice(0, 300));
    } finally {
      setSalvando(false);
    }
  }, [draft, qc]);

  return (
    <>
      <div className="orto-editor-bar">
        {!editing ? (
          editabile && (
            <button type="button" className="btn" onClick={apri} disabled={!layout}>
              Modifica orto
            </button>
          )
        ) : (
          <>
            <span className="eyebrow">trascina divisori, sonde e maniglie ⠿</span>
            <span className="spacer" />
            {dirty && <span className="dirty">modifiche non salvate</span>}
            <button type="button" className="btn" onClick={annulla} disabled={salvando}>
              Annulla
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={salva}
              disabled={salvando || !dirty || errori.length > 0}
            >
              {salvando ? 'Salvo…' : 'Salva'}
            </button>
          </>
        )}
      </div>

      {editing && draft && (
        <div className="orto-sonde-bar">
          <span className="eyebrow">sonde</span>
          {[...piazzate.keys()].sort().map((id) => (
            <span key={id} className="chip">
              {id.slice(-2)}
              <button
                type="button"
                title={`Togli ${id} dalla mappa`}
                onClick={() => setDraft(removeSensor(draft, id))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {editing && errori.length > 0 && (
        <p className="orto-avviso errore">{errori.map((e) => e.message).join(' · ')}</p>
      )}
      {erroreServer && <p className="orto-avviso errore">Salvataggio rifiutato: {erroreServer}</p>}
      {editing && riassegnate.map((r) => (
        <p key={r.id} className="orto-avviso">
          ⚠ {r.id} risulta installato in aiuola {r.da}. Spostandolo in fila {r.a}, le nuove letture
          verranno registrate come aiuola {r.a}. Lo storico precedente resta invariato.
        </p>
      ))}

      <OrtoMap
        layout={vista}
        sensors={sensors}
        thresholds={thresholds}
        activeSensor={activeSensor}
        onSelectSensor={onSelectSensor}
        editing={editing}
        onChange={setDraft}
        libereSonde={libereSonde}
        onNuovoSensore={setNuovoSuFila}
      />

      {nuovoSuFila !== null && draft && (
        <NewSensorModal
          fila={nuovoSuFila}
          onClose={() => setNuovoSuFila(null)}
          onRegistrato={(id) => setDraft(addSensor(draft, nuovoSuFila, id, 0.5))}
        />
      )}
    </>
  );
}
