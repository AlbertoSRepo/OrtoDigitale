import { useEffect, useRef } from 'react';

export type MenuItem =
  | { kind: 'action'; label: string; disabled?: boolean; danger?: boolean; run: () => void }
  | { kind: 'choice'; label: string; selected: boolean; run: () => void }
  | { kind: 'header'; label: string }
  | { kind: 'sep' };

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * Menu contestuale dell'editor. Niente sottomenu: le voci di scelta (coltura,
 * sensore) stanno in linea sotto un'intestazione. Un livello solo si usa con un
 * gesto in meno, e costa molto meno codice di un albero a scomparsa.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const fuori = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', esc);
    window.addEventListener('mousedown', fuori);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', esc);
      window.removeEventListener('mousedown', fuori);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  // Ribalta il menu se sborderebbe dalla finestra.
  const w = 210;
  const h = items.length * 28 + 12;
  const left = x + w > window.innerWidth ? Math.max(4, x - w) : x;
  const top = y + h > window.innerHeight ? Math.max(4, y - h) : y;

  return (
    <div ref={ref} className="ctx-menu" style={{ left, top, width: w }} role="menu">
      {items.map((it, i) => {
        if (it.kind === 'sep') return <div key={i} className="ctx-sep" />;
        if (it.kind === 'header') return <div key={i} className="ctx-header">{it.label}</div>;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`ctx-item${it.kind === 'choice' && it.selected ? ' selected' : ''}${
              it.kind === 'action' && it.danger ? ' danger' : ''
            }`}
            disabled={it.kind === 'action' && it.disabled}
            onClick={() => {
              it.run();
              onClose();
            }}
          >
            {it.kind === 'choice' && <span className="tick">{it.selected ? '•' : ''}</span>}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
