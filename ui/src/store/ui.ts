import { create } from 'zustand';
import type { AiResponse, ChatRole } from '../api/client';

export interface ChatTurn { role: ChatRole; content: string; parsed?: AiResponse; }

interface UiState {
  // Right-slide entry drawer: holds the entry id being viewed, or null.
  drawerEntryId: number | null;
  openDrawer: (id: number) => void;
  closeDrawer: () => void;

  // ⌘K command palette.
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;

  // Persistent AI assistant panel.
  aiPanelOpen: boolean;
  toggleAiPanel: () => void;

  // AI conversation - persists while the app is open, cleared on reload.
  aiMessages: ChatTurn[];
  aiBusy: boolean;
  appendAiMessage: (m: ChatTurn) => void;
  setAiBusy: (b: boolean) => void;
  resetAiChat: () => void;
}

export const useUi = create<UiState>((set) => ({
  drawerEntryId: null,
  openDrawer: (id) => set({ drawerEntryId: id }),
  closeDrawer: () => set({ drawerEntryId: null }),

  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),

  aiPanelOpen: false,
  toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),

  aiMessages: [],
  aiBusy: false,
  appendAiMessage: (m) => set((s) => ({ aiMessages: [...s.aiMessages, m] })),
  setAiBusy: (b) => set({ aiBusy: b }),
  resetAiChat: () => set({ aiMessages: [], aiBusy: false }),
}));
