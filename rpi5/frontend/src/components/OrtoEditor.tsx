import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { putLayout } from '../api/layout';
import type { Layout } from '../api/types';
import { ACTIVE_SENSORS, SENSOR_LOCATIONS } from '../config/sensors';
import { CROPS } from '../config/orto';
import {
  MAX_AREE, MAX_PIANTE, canSplit, changeSensor, mergeArea, placedSensors, removeSensor,
  setCrop, setPlantCount, splitArea, validateLayout,
} from '../helpers/layoutOps';
import { useMediaQuery } from '../helpers/useMediaQuery';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { OrtoMap, type Bersaglio } from './OrtoMap';

interface Props {
  layout: Layout | undefined;
  sensors: Parameters<typeof OrtoMap>[0]['sensors'];
  thresholds: Parameters<typeof OrtoMap>[0]['thresholds'];
  activeSensor: string | null;
  onSelectSensor: (id: string | null) => void;
}

/**
 * Involucro editor attorno alla mappa: tiene la bozza, costruisce il menu
 * contestuale e salva. La mappa resta ignara di tutto questo quando `editing`
 * è falso, che è il caso normale.
 */
export function OrtoEditor({ layout, sensors, thresholds, activeSensor, onSelectSensor }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Layout | null>(null);
  const [menu, setMenu] = useState<Bersaglio | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroreServer, setErroreServer] = useState<string | null>(null);

  // L'editor è desktop-only: serve un puntatore fine e spazio (step 13, §3).
  const grande = useMediaQuery('(min-width: 900px)');
  const fine = useMediaQuery('(pointer: fine)');
  const editabile = grande && fine;

  const vista = editing && draft ? draft : layout;
  const dirty = !!draft && !!layout && JSON.stringify(draft) !== JSON.stringify(layout);
  const errori = useMemo(() => (draft ? validateLayout(draft) : []), [draft]);

  // Se un sensore finisce in una fila diversa dalla sua aiuola di targa,
  // le nuove letture verranno registrate con la fila nuova (step 13, §9).
  const riassegnati = useMemo(() => {
    if (!draft) return [];
    return [...placedSensors(draft).entries()]
      .filter(([id, p]) => SENSOR_LOCATIONS[id] && SENSOR_LOCATIONS[id].aiuola !== p.fila)
      .map(([id, p]) => ({ id, da: SENSOR_LOCATIONS[id].aiuola, a: p.fila }));
  }, [draft]);

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
    setMenu(null);
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

  const voci = useMemo<MenuItem[]>(() => {
    if (!menu || !draft) return [];
    const cambia = (l: Layout) => setDraft(l);

    if (menu.tipo === 'area') {
      const row = draft.file.find((r) => r.id === menu.fila)!;
      const area = row.aree[menu.area];
      const items: MenuItem[] = [
        {
          kind: 'action',
          label: row.aree.length >= MAX_AREE ? `Dividi qui (max ${MAX_AREE} aree)` : 'Dividi qui',
          disabled: !canSplit(row, menu.at),
          run: () => cambia(splitArea(draft, menu.fila, menu.at)),
        },
        {
          kind: 'action', label: 'Unisci a sinistra', disabled: menu.area === 0,
          run: () => cambia(mergeArea(draft, menu.fila, menu.area, 'left')),
        },
        {
          kind: 'action', label: 'Unisci a destra', disabled: menu.area === row.aree.length - 1,
          run: () => cambia(mergeArea(draft, menu.fila, menu.area, 'right')),
        },
      ];
      if (area.crop !== 'libero') {
        items.push(
          { kind: 'sep' },
          { kind: 'header', label: `piante: ${area.n}` },
          {
            kind: 'action', label: 'Una in meno', disabled: area.n <= 0,
            run: () => cambia(setPlantCount(draft, menu.fila, menu.area, area.n - 1)),
          },
          {
            kind: 'action', label: 'Una in più', disabled: area.n >= MAX_PIANTE,
            run: () => cambia(setPlantCount(draft, menu.fila, menu.area, area.n + 1)),
          },
        );
      }
      items.push({ kind: 'sep' }, { kind: 'header', label: 'coltura' });
      for (const k of Object.keys(CROPS)) {
        items.push({
          kind: 'choice', label: CROPS[k].label, selected: area.crop === k,
          run: () => cambia(setCrop(draft, menu.fila, menu.area, k)),
        });
      }
      return items;
    }

    // menu.tipo === 'sonda'
    const piazzati = placedSensors(draft);
    const liberi = [...ACTIVE_SENSORS].filter((id) => !piazzati.has(id)).sort();
    const items: MenuItem[] = [
      {
        kind: 'action', label: 'Rimuovi misuratore', danger: true,
        run: () => cambia(removeSensor(draft, menu.sensorId)),
      },
    ];
    if (liberi.length) {
      items.push({ kind: 'sep' }, { kind: 'header', label: 'sostituisci con' });
      for (const id of liberi) {
        items.push({
          kind: 'choice', label: id, selected: false,
          run: () => cambia(changeSensor(draft, menu.sensorId, id)),
        });
      }
    }
    return items;
  }, [menu, draft]);

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
            <span className="eyebrow">
              tasto destro per il menu · trascina divisori e sonde
            </span>
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

      {editing && errori.length > 0 && (
        <p className="orto-avviso errore">{errori.map((e) => e.message).join(' · ')}</p>
      )}
      {erroreServer && <p className="orto-avviso errore">Salvataggio rifiutato: {erroreServer}</p>}
      {editing && riassegnati.map((r) => (
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
        onContext={setMenu}
      />

      {menu && (
        <ContextMenu x={menu.clientX} y={menu.clientY} items={voci} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
