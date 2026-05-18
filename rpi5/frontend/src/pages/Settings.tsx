import { useState } from 'react';
import { useStore } from '../state/store';
import { useShutdown, useShutdownCancel, useSystemHealth } from '../api/system';
import { ShutdownModal } from '../components/ShutdownModal';
import { SystemStats } from '../components/SystemStats';
import { fmtHM } from '../helpers/formatDuration';

const APP_VERSION = '0.1.0';

export function Settings() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const healthQ = useSystemHealth();
  const shutdownMut = useShutdown();
  const cancelMut = useShutdownCancel();

  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [shutdownScheduled, setShutdownScheduled] = useState(false);

  const onConfirm = () => {
    shutdownMut.mutate(undefined, {
      onSuccess: (data) => {
        setModalOpen(false);
        setShutdownScheduled(true);
        setToast(`Spegnimento programmato. Disconnetto in ${data.scheduled_in_seconds}s.`);
      },
    });
  };

  const onCancel = () => {
    cancelMut.mutate(undefined, {
      onSuccess: () => {
        setShutdownScheduled(false);
        setToast('Shutdown annullato.');
      },
    });
  };

  const health = healthQ.data;

  return (
    <div className="tab-panel">
      <section className="grid">
        <div className="card span-12">
          <div className="card-head">
            <h3>Settings</h3>
            <span className="eyebrow">v{APP_VERSION}</span>
          </div>

          <div className="settings-list">
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-label">Tema</div>
                <div className="settings-sub">aspetto chiaro o scuro · persistito</div>
              </div>
              <div className="settings-action">
                <button
                  className="set-btn"
                  onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                >
                  {theme === 'light' ? 'passa a scuro' : 'passa a chiaro'}
                </button>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-label">Diagnostica</div>
                <div className="settings-sub">stato componenti · uptime</div>
              </div>
              <div className="settings-action" style={{ textAlign: 'right' }}>
                <HealthBadges
                  loading={healthQ.isLoading}
                  uptimeSeconds={health?.uptime_seconds ?? null}
                  mode={health?.mode ?? null}
                  valveState={health?.valve_state ?? 'unknown'}
                  valveReachable={health?.valve_reachable ?? null}
                  sensorsOnline={health?.sensors_online ?? 0}
                  sensorsTotal={health?.sensors_total ?? 6}
                />
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-label">Sistema</div>
                <div className="settings-sub">disco · cpu · ram · temperatura</div>
              </div>
              <div className="settings-action" style={{ textAlign: 'right' }}>
                <SystemStats />
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-label">Spegnimento Raspberry Pi</div>
                <div className="settings-sub">arresta il sistema · richiede riavvio fisico</div>
              </div>
              <div className="settings-action" style={{ display: 'flex', gap: 8 }}>
                {shutdownScheduled && (
                  <button
                    className="set-btn"
                    onClick={onCancel}
                    disabled={cancelMut.isPending}
                  >
                    annulla shutdown
                  </button>
                )}
                <button
                  className="set-btn set-btn-danger"
                  onClick={() => setModalOpen(true)}
                  disabled={shutdownMut.isPending}
                >
                  spegni
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {modalOpen && (
        <ShutdownModal
          onClose={() => setModalOpen(false)}
          onConfirm={onConfirm}
          pending={shutdownMut.isPending}
          errorText={shutdownMut.error ? (shutdownMut.error as Error).message : null}
        />
      )}

      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

interface HealthProps {
  loading: boolean;
  uptimeSeconds: number | null;
  mode: string | null;
  valveState: string;
  valveReachable: boolean | null;
  sensorsOnline: number;
  sensorsTotal: number;
}

function HealthBadges({ loading, uptimeSeconds, mode, valveState, valveReachable, sensorsOnline, sensorsTotal }: HealthProps) {
  if (loading) {
    return <span style={{ color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>…</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
      <span>uptime: <strong style={{ color: 'var(--ink)' }}>{fmtHM(uptimeSeconds)}</strong></span>
      <span>mode: <strong style={{ color: 'var(--ink)' }}>{mode ?? '—'}</strong></span>
      <span>valvola: <strong style={{ color: valveReachable === false ? 'var(--terra)' : 'var(--ink)' }}>{valveState} {valveReachable === false ? '· offline' : ''}</strong></span>
      <span>sensori online: <strong style={{ color: 'var(--ink)' }}>{sensorsOnline}/{sensorsTotal}</strong></span>
    </div>
  );
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  setTimeout(onClose, 5000);
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        padding: '12px 16px',
        background: 'rgba(20,19,15,0.92)',
        color: '#fbf6ea',
        border: '0.5px solid rgba(255,255,255,0.18)',
        fontFamily: 'var(--mono)',
        fontSize: 12,
        letterSpacing: '0.04em',
        zIndex: 200,
        boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
      }}
    >
      {text}
    </div>
  );
}
