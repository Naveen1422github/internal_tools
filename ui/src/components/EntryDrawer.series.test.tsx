// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
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

  it('the supersede prompt accepts SH-3 and sends string refs', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('sh-3');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    useUi.getState().openDrawer('SH-12');
    render(<MemoryRouter><EntryDrawer /></MemoryRouter>);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Supersede' })));
    await waitFor(() => expect(api.supersede).toHaveBeenCalledWith(['SH-12'], 'SH-3'));
  });

  it('the supersede prompt refuses SH3', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('SH3');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    api.supersede.mockClear();
    useUi.getState().openDrawer('SH-12');
    render(<MemoryRouter><EntryDrawer /></MemoryRouter>);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Supersede' })));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(api.supersede).not.toHaveBeenCalled();
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
