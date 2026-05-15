import type { ValveInterval } from '../api/types';
import { fmtDateTime } from '../helpers/formatDate';
import { fmtDurationShort } from '../helpers/formatDuration';

interface Props {
  intervals: ValveInterval[] | undefined;
  max?: number;
}

export function EventsList({ intervals, max = 5 }: Props) {
  if (!intervals?.length) {
    return (
      <div
        className="events-list"
        style={{ padding: 12, color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 11 }}
      >
        nessun evento
      </div>
    );
  }
  const items = intervals.slice().sort((a, b) => b.start - a.start).slice(0, max);
  return (
    <div className="events-list">
      {items.map((iv, i) => (
        <div key={`${iv.start}-${i}`} className="ev">
          <span
            className="bar"
            style={{ background: iv.trigger === 'manual' ? 'var(--terra-2)' : 'var(--water-2)' }}
          />
          <span className="when">
            {fmtDateTime(iv.start)} → {fmtDateTime(iv.end)}
          </span>
          <span className="dur tabular">{fmtDurationShort(iv.duration_seconds)}</span>
          <span className="pill" style={{ padding: '2px 6px', fontSize: 9 }}>
            {iv.trigger}
          </span>
        </div>
      ))}
    </div>
  );
}
