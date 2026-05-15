import { useEffect, useRef, useState } from 'react';

interface Props {
  onClose: () => void;
  onConfirm: () => void;
  pending?: boolean;
  errorText?: string | null;
}

export function ShutdownModal({ onClose, onConfirm, pending, errorText }: Props) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const enabled = text === 'SHUTDOWN' && !pending;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="conferma spegnimento"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 100,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div
        style={{
          width: 'min(420px, 92vw)',
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          padding: '22px 22px 18px',
          boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
        }}
      >
        <div className="dur-eyebrow" style={{ textAlign: 'left', marginBottom: 12 }}>
          spegnimento raspberry pi
        </div>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, margin: '0 0 14px' }}>
          Il sistema si spegnerà tra <strong>5 minuti</strong>. Sarà necessario alimentazione fisica per riavviare.
          Per confermare, digita <code>SHUTDOWN</code>.
        </p>
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="SHUTDOWN"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          disabled={pending}
          style={{
            width: '100%',
            padding: '10px 12px',
            border: '1px solid var(--rule)',
            background: 'var(--card-2)',
            color: 'var(--ink)',
            fontFamily: 'var(--mono)',
            fontSize: 13,
            letterSpacing: '0.08em',
            marginBottom: 14,
          }}
        />
        {errorText && (
          <div
            style={{
              padding: '8px 10px',
              border: '1px solid var(--terra)',
              color: 'var(--terra)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              marginBottom: 12,
            }}
          >
            {errorText}
          </div>
        )}
        <div className="confirm-actions">
          <button className="dur-chip" onClick={onClose} disabled={pending}>
            annulla
          </button>
          <button
            className="dur-chip is-danger"
            onClick={onConfirm}
            disabled={!enabled}
            style={{ opacity: enabled ? 1 : 0.45 }}
          >
            {pending ? '…' : 'conferma'}
          </button>
        </div>
      </div>
    </div>
  );
}
