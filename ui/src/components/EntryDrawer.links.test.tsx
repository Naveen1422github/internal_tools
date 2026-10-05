// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// J17 (piece 2 stage A): the drawer follows links by the target's ULID.
const base = { id: 1, ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV', type: 'decision', title: 'Linker', summary: 's', modules: [] };
const entryWith = (refs: EntryRef[]) => ({ ...base, refs });
let current = entryWith([]);

vi.mock('../api/client', () => ({
  getEntry: vi.fn(async () => current),
  entryByUlid: vi.fn(async () => current),
  upsertEntry: vi.fn(),
  supersede: vi.fn(),
  deleteEntry: vi.fn(),
}));
vi.mock('../sync/useSyncOverview', () => ({ useSyncOverview: () => null }));

import EntryDrawer from './EntryDrawer';
import { useUi } from '../store/ui';
import type { EntryRef } from '../api/client';

function show(refs: EntryRef[]) {
  current = entryWith(refs);
  useUi.getState().openDrawer(1);
  render(<MemoryRouter><EntryDrawer /></MemoryRouter>);
}

describe('EntryDrawer: entry links', () => {
  beforeEach(() => useUi.getState().closeDrawer());
  afterEach(() => cleanup());

  it('a link whose target is here is a button that opens the note by ULID', async () => {
    show([{ ref_type: 'entry', ref_value: 'E-214', target: { present: true, ulid: 'U', id: 214, title: 'T', deleted: false } }]);
    const btn = await waitFor(() => screen.getByRole('button', { name: 'E-00214 · T' }));
    fireEvent.click(btn);
    expect(useUi.getState().drawerEntry).toEqual({ ulid: 'U' });
  });

  it('a deleted target still opens, labelled deleted', async () => {
    show([{ ref_type: 'entry', ref_value: 'E-214', target: { present: true, ulid: 'U', id: 214, title: 'T', deleted: true } }]);
    await waitFor(() => screen.getByRole('button', { name: 'E-00214 · T (deleted)' }));
  });

  it('a link whose target is not on this laptop is plain text, no button', async () => {
    show([{ ref_type: 'entry', ref_value: 'E-214', target: { present: false, ulid: 'U', id: null, title: null, deleted: false } }]);
    const text = await waitFor(() => screen.getByText('E-00214 · not on this laptop'));
    expect(text.tagName).not.toBe('BUTTON');
    expect(screen.queryByRole('button', { name: /E-00214/ })).toBeNull();
  });

  it('a link without a target (#214) is a button that opens 214 by number', async () => {
    show([{ ref_type: 'entry', ref_value: '#214' }]);
    const btn = await waitFor(() => screen.getByRole('button', { name: 'E-00214' }));
    fireEvent.click(btn);
    expect(useUi.getState().drawerEntry).toEqual({ id: 214 });
  });
});
