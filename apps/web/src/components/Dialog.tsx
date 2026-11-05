import { type ReactNode, useEffect, useRef } from 'react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * Modal dialog on the native <dialog>: focus trap, Esc and an inert background come from the
 * browser. Every way of closing goes through `dialog.close()` while the element is still in the
 * document, and only then tells the parent (which unmounts it), so focus can go back to the
 * control that opened it.
 */
export function Dialog({ title, onClose, children, className = '' }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
    if (!dialog.open) dialog.showModal?.();
    return () => {
      if (dialog.open) dialog.close?.();
    };
  }, []);

  const close = () => {
    if (ref.current?.open)
      ref.current.close(); // fires `close`, handled below
    else onClose();
  };

  return (
    // Backdrop clicks close the dialog; Esc and focus handling come from <dialog> itself.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-label={title}
      onClose={() => {
        const target = opener.current;
        if (target?.isConnected) target.focus();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close(); // backdrop click
      }}
    >
      <header className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
