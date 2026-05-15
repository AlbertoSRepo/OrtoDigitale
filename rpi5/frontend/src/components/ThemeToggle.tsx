import { useStore } from '../state/store';

export function ThemeToggle() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  return (
    <button
      className="theme-btn"
      onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      title="cambia tema"
      aria-label="cambia tema"
    >
      {theme === 'light' ? '☾' : '☀'}
    </button>
  );
}
