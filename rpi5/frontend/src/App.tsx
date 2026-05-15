import { useEffect } from 'react';
import { useStore } from './state/store';
import { Topbar } from './components/Topbar';
import { Orto } from './pages/Orto';
import { Waterflow } from './pages/Waterflow';
import { Settings } from './pages/Settings';

export function App() {
  const theme = useStore((s) => s.theme);
  const activeTab = useStore((s) => s.activeTab);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="app">
      <Topbar />
      <main>
        {activeTab === 'orto' && <Orto />}
        {activeTab === 'waterflow' && <Waterflow />}
        {activeTab === 'settings' && <Settings />}
      </main>
      <footer className="foot">
        <span>orto digitale · v0.1</span>
        <span>{new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
      </footer>
    </div>
  );
}
