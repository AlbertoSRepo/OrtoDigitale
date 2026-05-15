import { TabNav } from './TabNav';
import { ThemeToggle } from './ThemeToggle';

export function Topbar() {
  return (
    <header
      className="topbar"
      style={{ padding: '0px', margin: '0px 0px 28px', borderWidth: '0px 0px 1px' }}
    >
      <div className="brand">
        <img className="logo" src="/orto-digitale-title.png" alt="Orto Digitale" />
      </div>
      <div className="meta">
        <span className="live">live</span>
        <TabNav />
        <ThemeToggle />
      </div>
    </header>
  );
}
