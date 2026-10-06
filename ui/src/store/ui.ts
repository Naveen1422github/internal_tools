import { create } from 'zustand';
import type { AiResponse, ChatRole } from '../api/client';
import { formatNoteRef, parseNoteRef } from '../format';

// By E-number, by ULID (a followed link, J17), or by a project reference "SH-12" (stage B1).
export type DrawerEntry = { id: number } | { ulid: string } | { ref: string };

export interface ChatTurn { role: ChatRole; content: string; parsed?: AiResponse; }

interface UiState {
  // Right-slide entry drawer: the note being viewed, by number (typed or
  // listed) or by ULID (a followed link, J17), or null.
  drawerEntry: DrawerEntry | null;
  openDrawer: (target: number | string | { ulid: string }) => void;
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

/** A string is parsed like core does: E forms open by number, "SH-12" by reference. */
function toDrawerEntry(target: number | string | { ulid: string }): DrawerEntry | null {
  if (typeof target === 'number') return { id: target };
  if (typeof target === 'string') {
    const r = parseNoteRef(target);
    if (!r) return null;
    return r.series === 'E' ? { id: r.id } : { ref: formatNoteRef(r) };
  }
  return { ulid: target.ulid };
}

export const useUi = create<UiState>((set) => ({
  drawerEntry: null,
  openDrawer: (target) => set({ drawerEntry: toDrawerEntry(target) }),
  closeDrawer: () => set({ drawerEntry: null }),

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
