import { useStore, type ActiveTab } from '../state/store';

const TABS: { id: ActiveTab; label: string }[] = [
  { id: 'orto', label: 'Orto' },
  { id: 'waterflow', label: 'Waterflow' },
  { id: 'settings', label: 'Settings' },
];

export function TabNav() {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  return (
    <div className="tab-nav">
      {TABS.map((t) => (
        <button
          key={t.id}
          className={activeTab === t.id ? 'tab-active' : ''}
          onClick={() => setActiveTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
