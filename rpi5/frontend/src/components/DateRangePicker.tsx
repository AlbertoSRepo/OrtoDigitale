import { useEffect, useRef, useState } from 'react';
import { resolvePeriod, type Period } from '../state/store';
import { fmtDayShort, fromInputDate, toInputDate } from '../helpers/formatDate';

interface Props {
  value: Period;
  onChange: (p: Period) => void;
}

const PRESETS: Period[] = ['24h', '7d', '30d'];

export function DateRangePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const resolved = resolvePeriod(value);
  const [draftFrom, setDraftFrom] = useState(toInputDate(new Date(resolved.t0)));
  const [draftTo, setDraftTo] = useState(toInputDate(new Date(resolved.t1)));

  useEffect(() => {
    const r = resolvePeriod(value);
    setDraftFrom(toInputDate(new Date(r.t0)));
    setDraftTo(toInputDate(new Date(r.t1)));
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isPreset = (p: Period) => resolved.kind === 'preset' && value === p;
  const setPreset = (p: Period) => {
    onChange(p);
    setOpen(false);
  };
  const apply = () => {
    if (!draftFrom || !draftTo) return;
    let a = fromInputDate(draftFrom, false).getTime();
    let b = fromInputDate(draftTo, true).getTime();
    if (b < a) [a, b] = [b, a];
    onChange({ start: a, end: b });
    setOpen(false);
  };

  const triggerLabel =
    resolved.kind === 'preset'
      ? String(resolved.preset).toUpperCase()
      : `${fmtDayShort(new Date(resolved.t0))} → ${fmtDayShort(new Date(resolved.t1))}`;

  return (
    <div className={`drp ${open ? 'drp-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`drp-trigger ${resolved.kind === 'custom' ? 'is-custom' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg className="drp-ico" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <rect x="2" y="3.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
          <line x1="2" y1="6.5" x2="14" y2="6.5" stroke="currentColor" strokeWidth="1" />
          <line x1="5.5" y1="2" x2="5.5" y2="5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          <line x1="10.5" y1="2" x2="10.5" y2="5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
        <span className="drp-label">{triggerLabel}</span>
        <span className="drp-chev" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="drp-pop" role="dialog">
          <div className="drp-eyebrow">intervallo</div>
          <div className="drp-presets">
            {PRESETS.map((p) => (
              <button
                key={String(p)}
                type="button"
                className={`drp-chip ${isPreset(p) ? 'on' : ''}`}
                onClick={() => setPreset(p)}
              >
                {String(p).toUpperCase()}
              </button>
            ))}
          </div>

          <div className="drp-divider" />

          <div className="drp-eyebrow">personalizzato</div>
          <div className="drp-fields">
            <label className="drp-field">
              <span>dal</span>
              <input
                type="date"
                value={draftFrom}
                max={draftTo || undefined}
                onChange={(e) => setDraftFrom(e.target.value)}
              />
            </label>
            <span className="drp-arrow" aria-hidden="true">→</span>
            <label className="drp-field">
              <span>al</span>
              <input
                type="date"
                value={draftTo}
                min={draftFrom || undefined}
                max={toInputDate(new Date())}
                onChange={(e) => setDraftTo(e.target.value)}
              />
            </label>
          </div>

          <div className="drp-actions">
            <button type="button" className="drp-secondary" onClick={() => setOpen(false)}>
              annulla
            </button>
            <button type="button" className="drp-primary" onClick={apply}>
              applica
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
