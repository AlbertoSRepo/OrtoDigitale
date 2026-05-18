import { useEffect, useState } from 'react';

/**
 * Traccia lo stato online del browser via navigator.onLine + eventi window.
 * Lo stato è "online" se il device ha (almeno teoricamente) connettività di rete.
 * Non garantisce che il backend sia raggiungibile — quello lo decide la fetch.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  return online;
}
