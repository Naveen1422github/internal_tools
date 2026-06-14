import { create } from 'zustand';

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
}

export const useUi = create<UiState>((set) => ({
  drawerEntryId: null,
  openDrawer: (id) => set({ drawerEntryId: id }),
  closeDrawer: () => set({ drawerEntryId: null }),

  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),

  aiPanelOpen: false,
  toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
}));
