import type { ReactNode } from 'react';

export default function Drawer({
  open, onClose, children,
}: { open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="absolute right-0 top-0 h-full w-[480px] max-w-[90vw] bg-white dark:bg-gray-950 shadow-xl border-l border-gray-200 dark:border-gray-800 overflow-y-auto">
        <div className="p-4">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-900 dark:hover:text-gray-100">Close ✕</button>
        </div>
        <div className="px-4 pb-8">{children}</div>
      </aside>
    </div>
  );
}
