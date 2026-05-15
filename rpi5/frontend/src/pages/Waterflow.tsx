import { useStore, resolvePeriod } from '../state/store';
import { useValveCumulative, useValveIntervals, useValveState } from '../api/valve';
import { ValveCard } from '../components/ValveCard';
import { ValveStepChart } from '../components/ValveStepChart';
import { EventsList } from '../components/EventsList';
import { DateRangePicker } from '../components/DateRangePicker';
import { fmtHM } from '../helpers/formatDuration';

export function Waterflow() {
  const period = useStore((s) => s.periodValve);
  const setPeriod = useStore((s) => s.setPeriodValve);

  const stateQ = useValveState();
  const intervalsQ = useValveIntervals(period);
  const cumulativeQ = useValveCumulative(period);

  const resolved = resolvePeriod(period);

  return (
    <div className="tab-panel">
      <section className="grid" style={{ marginBottom: 18 }}>
        <div className="span-12">
          <ValveCard
            valve={stateQ.data}
            cumulativeSeconds={cumulativeQ.data?.total_open_seconds ?? null}
            cumulativeLabel={resolved.label}
            loading={stateQ.isLoading}
          />
        </div>
      </section>

      <section className="grid" style={{ marginBottom: 18 }}>
        <div className="card span-12">
          <div className="card-head">
            <h3>Apertura valvola</h3>
            <DateRangePicker value={period} onChange={setPeriod} />
          </div>
          <ValveStepChart intervals={intervalsQ.data} period={period} loading={intervalsQ.isLoading} />
        </div>
      </section>

      <section className="grid">
        <div className="card span-5">
          <div className="card-head">
            <h3>Cumulativo</h3>
            <span className="eyebrow">periodo {resolved.label}</span>
          </div>
          <div className="metric" style={{ padding: '8px 0' }}>
            <span className="num">
              {cumulativeQ.isLoading ? '…' : fmtHM(cumulativeQ.data?.total_open_seconds ?? null)}
            </span>
            <span className="lbl">tempo cumulato di apertura</span>
          </div>
        </div>
        <div className="card span-7">
          <div className="card-head">
            <h3>Ultimi eventi</h3>
            <span className="eyebrow">×5</span>
          </div>
          <EventsList intervals={intervalsQ.data} max={5} />
        </div>
      </section>
    </div>
  );
}
