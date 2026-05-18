import { useRegisterSW } from 'virtual:pwa-register/react';

export function UpdatePrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.error('SW registration error', error);
    },
  });

  if (!offlineReady && !needRefresh) return null;

  const close = () => {
    setOfflineReady(false);
    setNeedRefresh(false);
  };

  return (
    <div className="pwa-toast" role="status" aria-live="polite">
      <div className="pwa-toast-msg">
        {needRefresh
          ? 'Nuova versione disponibile'
          : 'App pronta per l’uso offline'}
      </div>
      <div className="pwa-toast-actions">
        {needRefresh && (
          <button
            type="button"
            className="pwa-toast-btn primary"
            onClick={() => updateServiceWorker(true)}
          >
            Aggiorna
          </button>
        )}
        <button type="button" className="pwa-toast-btn" onClick={close}>
          {needRefresh ? 'Più tardi' : 'Chiudi'}
        </button>
      </div>
    </div>
  );
}
