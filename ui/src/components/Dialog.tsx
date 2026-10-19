import { useEffect, useId, useRef, type ReactNode } from 'react';

// UI parity D13: the one dialog for confirmations and small forms, instead of
// the browser's alert/confirm/prompt. Escape or the backdrop cancels; focus
// starts on the first field (or Cancel) and returns to the opener on close.

export const buttonClass = 'rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed';
export const primaryClass = 'rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed';
export const dangerClass = 'rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed';

export interface DialogProps {
  title: string;
  children?: ReactNode;
  /** The main button; omit for a dialog that only shows something (then "Close"). */
  confirmLabel?: string;
  confirmTone?: 'primary' | 'danger';
  confirmDisabled?: boolean;
  /** A refusal or validation message, shown inside the dialog. */
  error?: string | null;
  busy?: boolean;
  onConfirm?: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}

/** aria-modal: Tab and Shift+Tab stay inside the dialog. */
function trapTab(e: React.KeyboardEvent, box: HTMLElement | null) {
  const items = box ? [...box.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !(el as HTMLButtonElement).disabled) : [];
  if (items.length === 0) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export default function Dialog({
  title, children, confirmLabel, confirmTone = 'primary', confirmDisabled, error, busy, onConfirm, onCancel, cancelLabel,
}: DialogProps) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
    (first ?? cancel.current)?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (onConfirm && !confirmDisabled && !busy) onConfirm();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); if (!busy) onCancel(); return; }
          if (e.key === 'Tab') trapTab(e, box.current);
        }}
        className="w-full max-w-lg max-h-full overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-5 shadow-xl"
      >
        <form onSubmit={submit} className="space-y-4">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          {children}
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" ref={cancel} onClick={onCancel} disabled={busy} className={buttonClass}>{cancelLabel ?? (confirmLabel ? 'Cancel' : 'Close')}</button>
            {confirmLabel && (
              <button type="submit" disabled={confirmDisabled || busy} className={confirmTone === 'danger' ? dangerClass : primaryClass}>
                {busy ? 'Working…' : confirmLabel}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
