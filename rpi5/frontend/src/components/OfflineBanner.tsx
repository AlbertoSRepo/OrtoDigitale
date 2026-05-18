import { useQueryClient } from '@tanstack/react-query';
import { useOnlineStatus } from '../helpers/useOnlineStatus';
import { useTick } from '../helpers/useTick';
import { fmtRelative } from '../helpers/formatDate';

const STALE_THRESHOLD_MS = 30_000;

function useLastSensorFetchTime(): number | null {
  const qc = useQueryClient();
  const state = qc.getQueryState(['sensors', 'last']);
  return state?.dataUpdatedAt && state.dataUpdatedAt > 0 ? state.dataUpdatedAt : null;
}

export function OfflineBanner() {
  useTick(5_000);
  const isOnline = useOnlineStatus();
  const lastFetch = useLastSensorFetchTime();

  const stale =
    lastFetch === null
      ? !isOnline // se non abbiamo mai fetchato e siamo offline → banner
      : Date.now() - lastFetch > STALE_THRESHOLD_MS;

  if (isOnline && !stale) return null;

  const rel = lastFetch ? fmtRelative(lastFetch) : '—';

  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <span className="offline-icon" aria-hidden="true">⚠</span>
      <span className="offline-text">
        {isOnline
          ? `Connessione lenta · ultimi dati ${rel}`
          : `Offline · visualizzazione dati dalla cache (${rel})`}
      </span>
    </div>
  );
}
