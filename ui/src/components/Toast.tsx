import { useEffect } from 'react';
import { create } from 'zustand';

// UI parity D13: short messages after an action ("Created project SC"), instead
// of alert(). Errors stay until dismissed; others fade after a few seconds.

export type ToastTone = 'success' | 'error' | 'info';
export interface ToastItem { id: number; text: string; tone: ToastTone }

interface ToastState {
  toasts: ToastItem[];
  push: (text: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
}

let next = 1;
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (text, tone = 'success') => set((s) => ({ toasts: [...s.toasts, { id: next++, text, tone }] })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Show a message from anywhere (a click handler, an effect). */
export const toast = (text: string, tone: ToastTone = 'success') => useToasts.getState().push(text, tone);

const TONE: Record<ToastTone, string> = {
  success: 'border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-900/30',
  error: 'border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/30',
  info: 'border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900',
};

function One({ t }: { t: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    if (t.tone === 'error') return;
    const h = setTimeout(() => dismiss(t.id), 6000);
    return () => clearTimeout(h);
  }, [t, dismiss]);
  return (
    <div role={t.tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow ${TONE[t.tone]}`}>
      <p className="flex-1 break-words whitespace-pre-line">{t.text}</p>
      <button type="button" onClick={() => dismiss(t.id)} className="text-xs font-medium text-gray-600 dark:text-gray-300 hover:underline">Dismiss</button>
    </div>
  );
}

export default function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div aria-live="polite" className="fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((t) => <One key={t.id} t={t} />)}
    </div>
  );
}
