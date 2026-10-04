import type { ReactNode } from 'react';
import Sidebar from './Sidebar';
import CommandPalette from './CommandPalette';
import EntryDrawer from './EntryDrawer';
import AiPanel from './AiPanel';
import KeyMissingNotice from './KeyMissingNotice';
import SyncBar from './SyncBar';
import { useUi } from '../store/ui';

export default function AppShell({ children }: { children: ReactNode }) {
  const { toggleAiPanel, aiPanelOpen, setPaletteOpen } = useUi();
  return (
    <div className="flex h-full text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-950">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        <KeyMissingNotice />
        <SyncBar />
        <header className="h-12 shrink-0 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-4">
          <button onClick={() => setPaletteOpen(true)} className="text-sm text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 font-medium">Search ⌘K</button>
          <button onClick={toggleAiPanel} className="text-sm text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 font-medium">AI Assistant</button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto p-6">{children}</div>
      </main>
      {aiPanelOpen && <AiPanel />}
      <CommandPalette />
      <EntryDrawer />
    </div>
  );
}
