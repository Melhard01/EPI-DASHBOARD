import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

// Open overlays, topmost last: Escape closes only the topmost one (a confirmation
// dialog on top of a drawer must not close both).
const openStack = [];

/**
 * Shared accessible overlay: role="dialog", Escape and backdrop close it, focus
 * moves into it on open and returns to the previously focused element on close,
 * and page scrolling is locked while it is open.
 */
function Overlay({ open, title, onClose, children, footer, side }) {
  const panelRef = useRef(null);
  const id = useId();

  // Always call the LATEST onClose without making it an effect dependency: callers pass
  // a new function on every render, and re-running the effect would steal focus from
  // whatever the user is typing into (and restore it to the page behind the dialog).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    openStack.push(id);
    const onKey = (event) => {
      if (event.key === 'Escape' && openStack.at(-1) === id) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const scrollLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      openStack.splice(openStack.indexOf(id), 1);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = scrollLock;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, id]);

  if (!open) return null;

  const panel = side
    ? 'ml-auto h-full w-full max-w-xl rounded-none sm:rounded-l-2xl'
    : 'm-auto w-full max-w-lg rounded-2xl';

  return (
    <div className="fixed inset-0 z-50 flex bg-slate-900/50" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`${panel} flex max-h-full flex-col overflow-hidden border border-line bg-surface shadow-xl outline-none`}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-surface-3">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Modal(props) {
  return <Overlay {...props} />;
}

export function Drawer(props) {
  return <Overlay {...props} side />;
}
