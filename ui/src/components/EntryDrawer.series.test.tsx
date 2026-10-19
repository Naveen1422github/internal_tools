// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stage B1: a project note prints and opens as SH-12; bare numbers stay E.
const sh12 = { id: 12, series: 'SH', ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV', type: 'decision', title: 'Project note', summary: 's', modules: [], refs: [] };
const api = vi.hoisted(() => ({
  getEntry: vi.fn(),
  entryByUlid: vi.fn(),
  upsertEntry: vi.fn(),
  supersede: vi.fn(async () => ({ ok: true, superseded: [12], by: 3 })),
  deleteEntry: vi.fn(),
  search: vi.fn(),
  modules: vi.fn(async () => ({ results: [] })),
  projectsList: vi.fn(async () => ({ projects: [], modules: [], copy_modules: [], office_url: null, me: null })),
}));
vi.mock('../api/client', () => api);
vi.mock('../sync/useSyncOverview', () => ({ useSyncOverview: () => null }));

import EntryDrawer from './EntryDrawer';
import CommandPalette from './CommandPalette';
import Knowledge from '../pages/Knowledge';
import { useUi } from '../store/ui';

describe('EntryDrawer: a project note', () => {
  beforeEach(() => {
    useUi.getState().closeDrawer();
    api.getEntry.mockImplementation(async () => sh12);
    api.entryByUlid.mockImplementation(async () => sh12);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('opens by "SH-12" and shows SH-12 in the header', async () => {
    useUi.getState().openDrawer('SH-12');
    expect(useUi.getState().drawerEntry).toEqual({ ref: 'SH-12' });
    render(<MemoryRouter><EntryDrawer /></MemoryRouter>);
    await waitFor(() => screen.getByText('SH-12'));
    expect(api.getEntry).toHaveBeenCalledWith('SH-12');
  });

  it('a typed "E-00007" or 7 opens by number, as before', () => {
    useUi.getState().openDrawer('E-00007');
    expect(useUi.getState().drawerEntry).toEqual({ id: 7 });
    useUi.getState().openDrawer(7);
    expect(useUi.getState().drawerEntry).toEqual({ id: 7 });
  });

  it('supersede: pick SH-3 in the note picker, confirm, and the refs are sent as strings (UI parity Task 12)', async () => {
    // The note itself comes back without its ULID matching (by number), and a pending note has no number: neither is offered.
    api.search.mockResolvedValue({ results: [{ id: 12, series: 'SH', title: 'Project note' }, { id: null, series: 'SH', title: 'Pending note' }, { id: 3, series: 'SH', ulid: '01ARZ3NDEKTSV4RRFFQ69G5FB0', title: 'Newer note' }] });
    useUi.getState().openDrawer('SH-12');
    render(<MemoryRouter><EntryDrawer /></MemoryRouter>);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Supersede' })));
    const dialog = within(screen.getByRole('dialog'));
    const list = await dialog.findByRole('list', { name: 'The note that replaces it' });
    await waitFor(() => within(list).getByText('Newer note'));
    expect(within(list).queryByText('Project note')).toBeNull();
    expect(within(list).queryByText('Pending note')).toBeNull();
    expect((dialog.getByRole('button', { name: 'Supersede' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(list).getByText('Newer note'));
    dialog.getByText(/SH-12 will be marked as superseded by SH-3/);
    fireEvent.click(dialog.getByRole('button', { name: 'Supersede' }));
    await waitFor(() => expect(api.supersede).toHaveBeenCalledWith(['SH-12'], 'SH-3'));
  });

  it('supersede: a refusal stays in the dialog word for word', async () => {
    const no = 'You need "Supersede notes" (note.supersede) in SH to do this';
    api.search.mockResolvedValue({ results: [{ id: 3, series: 'SH', ulid: '01ARZ3NDEKTSV4RRFFQ69G5FB0', title: 'Newer note' }] });
    api.supersede.mockRejectedValueOnce(new Error(no));
    useUi.getState().openDrawer('SH-12');
    render(<MemoryRouter><EntryDrawer /></MemoryRouter>);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Supersede' })));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(await dialog.findByText('Newer note'));
    fireEvent.click(dialog.getByRole('button', { name: 'Supersede' }));
    expect((await dialog.findByRole('alert')).textContent).toBe(no);
  });

  it('delete asks in a dialog first; Cancel deletes nothing', async () => {
    api.deleteEntry.mockResolvedValue({ ok: true });
    useUi.getState().openDrawer('SH-12');
    render(<MemoryRouter><EntryDrawer /></MemoryRouter>);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Delete' })));
    within(screen.getByRole('dialog')).getByText(/It is usually better to supersede a note/);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.deleteEntry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteEntry).toHaveBeenCalledWith('SH-12'));
  });
});

describe('lists print SH-12 and open the project note', () => {
  beforeEach(() => {
    useUi.getState().closeDrawer();
    api.search.mockImplementation(async () => ({ results: [sh12] }));
  });
  afterEach(() => cleanup());

  it('command palette', async () => {
    useUi.getState().setPaletteOpen(true);
    render(<MemoryRouter><CommandPalette /></MemoryRouter>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'proj' } });
    const item = await waitFor(() => screen.getByText('SH-12'), { timeout: 2000 });
    fireEvent.click(item);
    expect(useUi.getState().drawerEntry).toEqual({ ref: 'SH-12' });
  });

  it('Knowledge list', async () => {
    render(<MemoryRouter><Knowledge /></MemoryRouter>);
    const item = await waitFor(() => screen.getByText('SH-12'));
    fireEvent.click(item);
    expect(useUi.getState().drawerEntry).toEqual({ ref: 'SH-12' });
  });
});
