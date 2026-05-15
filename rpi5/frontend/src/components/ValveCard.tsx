import { useEffect, useRef, useState } from 'react';
import type { ValveState } from '../api/types';
import { useCloseValve, useOpenValve } from '../api/valve';
import { useTick } from '../helpers/useTick';
import { fmtClock, fmtHM } from '../helpers/formatDuration';
import { fmtRelative } from '../helpers/formatDate';

interface Props {
  valve: ValveState | undefined;
  cumulativeSeconds: number | null;
  cumulativeLabel: string;
  loading?: boolean;
}

const DURATIONS = [
  { label: '5m', sec: 5 * 60 },
  { label: '15m', sec: 15 * 60 },
  { label: '30m', sec: 30 * 60 },
  { label: '1h', sec: 60 * 60 },
];

export function ValveCard({ valve, cumulativeSeconds, cumulativeLabel, loading }: Props) {
  useTick(1000);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const openMut = useOpenValve();
  const closeMut = useCloseValve();
  const isLoading = loading || !valve;
  const isOpen = valve?.state === 'ON';

  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!feedback) return;
    const id = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(id);
  }, [feedback]);

  const onPrimary = () => {
    if (isOpen) {
      closeMut.mutate(undefined, {
        onSuccess: () => setFeedback({ ok: true, text: 'valvola chiusa' }),
        onError: (e) => setFeedback({ ok: false, text: `errore: ${(e as Error).message}` }),
      });
    } else {
      setPickerOpen((v) => !v);
    }
  };
  const pickDuration = (sec: number) => {
    setPickerOpen(false);
    openMut.mutate(sec, {
      onSuccess: () => setFeedback({ ok: true, text: `apertura per ${sec / 60} min richiesta` }),
      onError: (e) => setFeedback({ ok: false, text: `errore: ${(e as Error).message}` }),
    });
  };

  const openSinceSec = valve?.open_since_seconds ?? 0;
  const remainSec = valve?.auto_close_in_seconds ?? 0;
  const sinceMS = fmtClock(openSinceSec);
  const remainMS = fmtClock(remainSec);
  const lastChange = valve?.last_change ? new Date(valve.last_change) : null;

  const mutating = openMut.isPending || closeMut.isPending;

  return (
    <div className={`card valve ${isOpen ? 'open' : ''}`}>
      <div className="valve-grid">
        <div className="left">
          <div className="eyebrow">irrigazione · {valve?.valve_id ?? 'SWV_01'}</div>
          <div className="status">
            {isLoading ? '…' : isOpen ? 'in flusso' : 'in attesa'}
            <span className="acronym">
              {isLoading ? '' : isOpen ? 'valvola aperta' : 'valvola chiusa'}
            </span>
          </div>

          {isOpen ? (
            <>
              <div className="time-row">
                <div className="block">
                  <span className="num tabular">
                    {sinceMS[0]}
                    <span className="colon">:</span>
                    {sinceMS[1]}
                  </span>
                  <span className="lbl">aperta da</span>
                </div>
                <div className="block">
                  <span
                    className="num tabular"
                    style={{ color: remainSec < 60 ? 'var(--terra)' : 'inherit' }}
                  >
                    {remainMS[0]}
                    <span className="colon">:</span>
                    {remainMS[1]}
                  </span>
                  <span className="lbl">spegnimento tra</span>
                </div>
              </div>
              <div className="block cumul-block">
                <span className="num cumul tabular">{fmtHM(cumulativeSeconds)}</span>
                <span className="lbl">cumulato {cumulativeLabel}</span>
              </div>
            </>
          ) : (
            <>
              <div className="time-row">
                <div className="block">
                  <span className="num tabular">{lastChange ? fmtRelative(lastChange) : '—'}</span>
                  <span className="lbl">ultima chiusura</span>
                </div>
                <div className="block">
                  <span className="num tabular">
                    {valve ? `${Math.floor(valve.max_duration_seconds / 60)}m` : '—'}
                  </span>
                  <span className="lbl">durata max</span>
                </div>
              </div>
              <div className="block cumul-block">
                <span className="num cumul tabular">{fmtHM(cumulativeSeconds)}</span>
                <span className="lbl">cumulato {cumulativeLabel}</span>
              </div>
            </>
          )}

          <div className="chips-row">
            <span className={`chip ${isOpen ? 'open' : 'closed'}`}>
              <span className="dot" />
              {isOpen ? 'open' : 'closed'}
            </span>
            <span className="chip">
              <span className="dot" />
              reachable: {valve?.reachable === null || valve?.reachable === undefined ? '—' : valve.reachable ? 'sì' : 'no'}
            </span>
            <span className="chip">
              <span className="dot" />
              zigbee {valve?.linkquality ?? '—'}/100
            </span>
          </div>

          {feedback && (
            <div
              role="status"
              style={{
                marginTop: 12,
                padding: '8px 12px',
                border: '1px solid var(--rule)',
                color: feedback.ok ? 'var(--moss-2)' : 'var(--terra)',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              {feedback.text}
            </div>
          )}
        </div>

        <div className="valve-stage">
          <img className="valvola" src="/valvola.svg" alt="valvola Sonoff" />
          <span className="led" />
          <div className="drops">{isOpen && <img src="/water_drop.svg" className="drop drop-static" alt="" />}</div>
          <button
            className="valve-btn valve-btn-overlay"
            onClick={onPrimary}
            disabled={mutating || isLoading}
            aria-haspopup={isOpen ? undefined : 'dialog'}
            aria-expanded={isOpen ? undefined : pickerOpen}
            aria-label={isOpen ? 'chiudi valvola' : 'apri valvola'}
          >
            <span className="ring-anim" />
            <span className="label">
              <span className="primary">{isOpen ? 'chiudi' : 'apri'}</span>
              <small>{mutating ? '…' : isOpen ? 'stop manuale' : 'ora'}</small>
            </span>
          </button>

          {pickerOpen && !isOpen && (
            <div className="dur-pop" role="dialog" aria-label="tempo di apertura" ref={pickerRef}>
              <div className="dur-eyebrow">tempo di apertura</div>
              <div className="dur-grid">
                {DURATIONS.map((d) => (
                  <button
                    key={d.label}
                    type="button"
                    className="dur-chip"
                    onClick={() => pickDuration(d.sec)}
                    disabled={mutating}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <div className="dur-hint">la valvola si chiude automaticamente al termine</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
