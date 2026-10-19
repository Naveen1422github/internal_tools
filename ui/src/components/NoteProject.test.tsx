// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// UI parity Task 10 (B): notes show their project; filter by it; copy a note to another project.
const sh12 = {
  id: 12, series: 'SH', ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV', type: 'decision', title: 'Project note', summary: 's', modules: [], refs: [],
  project: { code: 'SH', name: 'Support hub', mode: 'team', left: false },
};
const PROJECTS = [
  { ulid: 'u-sh', code: 'SH', name: 'Support hub', mode: 'team', left_at: null },
  { ulid: 'u-nv', code: 'NV', name: 'Navi', mode: 'solo', left_at: null },
  { ulid: 'u-ol', code: 'OL', name: 'Old', mode: 'team', left_at: '2026-10-01' },
];
const api = vi.hoisted(() => ({
  getEntry: vi.fn(), entryByUlid: vi.fn(), upsertEntry: vi.fn(), supersede: vi.fn(), deleteEntry: vi.fn(),
  search: vi.fn(), modules: vi.fn(), projectsList: vi.fn(), copyPlan: vi.fn(), copyApply: vi.fn(),
}));
vi.mock('../api/client', () => api);
vi.mock('../sync/useSyncOverview', () => ({ useSyncOverview: () => null }));

import EntryDrawer from './EntryDrawer';
import Knowledge from '../pages/Knowledge';
import Toaster, { useToasts } from './Toast';
import { useUi } from '../store/ui';

beforeEach(() => {
  useUi.getState().closeDrawer();
  api.getEntry.mockResolvedValue(sh12);
  api.entryByUlid.mockResolvedValue(sh12);
  api.modules.mockResolvedValue({ results: [] });
  api.projectsList.mockResolvedValue({ projects: PROJECTS, modules: [], copy_modules: [], office_url: null, me: null });
  api.search.mockResolvedValue({ results: [{ ...sh12, project_ulid: 'u-sh' }, { id: 3, series: 'E', type: 'gotcha', title: 'Loose', summary: 's', project_ulid: null }] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); useToasts.setState({ toasts: [] }); });

describe('notes show their project', () => {
  it('Knowledge: a project filter (all, each project, none) and a project chip on project notes', async () => {
    render(<MemoryRouter><Knowledge /></MemoryRouter>);
    const filter = await screen.findByLabelText('Project') as HTMLSelectElement;
    await waitFor(() => expect([...filter.options].map((o) => o.textContent)).toEqual(['All projects', 'SH · Support hub', 'NV · Navi', 'OL · Old', 'No project (E series)']));
    await screen.findByText('SH · Support hub', { selector: 'span' });
    fireEvent.change(filter, { target: { value: 'none' } });
    await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ project: 'none' })));
  });

  it('the drawer shows the note\'s project', async () => {
    useUi.getState().openDrawer('SH-12');
    render(<MemoryRouter><EntryDrawer /></MemoryRouter>);
    await screen.findByText('SH · Support hub (team)');
  });

  it('copy to another project: pick a project (not its own, not a left one), see the list, copy, open the copy', async () => {
    api.copyPlan.mockResolvedValue({ source: {}, target: { ulid: 'u-nv', code: 'NV', name: 'Navi', mode: 'solo' }, items: [{ ulid: sh12.ulid }], skipped: [], lines: ['Copy 1 note from note SH-12 into NV (Navi, solo):'] });
    api.copyApply.mockResolvedValue({ copied: [{ from: 'SH-12', to: 'NV-4', pending: false }], lines: ['Copied 1 note from note SH-12 into NV (Navi, solo):', '  SH-12 -> NV-4'] });
    useUi.getState().openDrawer('SH-12');
    render(<MemoryRouter><EntryDrawer /><Toaster /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy to another project' }));
    const dialog = within(screen.getByRole('dialog'));
    const into = await dialog.findByLabelText('Copy into') as HTMLSelectElement;
    expect([...into.options].map((o) => o.textContent)).toEqual(['Choose a project…', 'NV · Navi']);
    fireEvent.change(into, { target: { value: 'NV' } });
    await waitFor(() => expect(api.copyPlan).toHaveBeenCalledWith({ from: `note:${sh12.ulid}`, to: 'NV' }));
    await dialog.findByText('Copy 1 note from note SH-12 into NV (Navi, solo):');
    fireEvent.click(dialog.getByRole('button', { name: 'Copy note' }));
    await waitFor(() => expect(api.copyApply).toHaveBeenCalledWith({ from: `note:${sh12.ulid}`, to: 'NV' }, [sh12.ulid], 'u-nv'));
    await screen.findByText(/SH-12 -> NV-4/);
    expect(useUi.getState().drawerEntry).toEqual({ ref: 'NV-4' });
  });

  it('copy: a refusal (no note.create in the target) is shown word for word; an already-copied note says where', async () => {
    const no = 'You need "Create notes" (note.create) in NV to do this';
    api.copyPlan.mockRejectedValueOnce(Object.assign(new Error(no), { status: 403 }))
      .mockResolvedValueOnce({ source: {}, target: { ulid: 'u-nv', code: 'NV', name: 'Navi', mode: 'solo' }, items: [], skipped: [{ ulid: sh12.ulid, ref: 'SH-12', title: 't', reason: 'already copied to NV-4' }], lines: ['x'] });
    useUi.getState().openDrawer('SH-12');
    render(<MemoryRouter><EntryDrawer /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy to another project' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(await dialog.findByLabelText('Copy into'), { target: { value: 'NV' } });
    expect((await dialog.findByRole('alert')).textContent).toBe(no);
    fireEvent.change(dialog.getByLabelText('Copy into'), { target: { value: '' } });
    fireEvent.change(dialog.getByLabelText('Copy into'), { target: { value: 'NV' } });
    await dialog.findByText('This note was already copied to NV-4.');
    expect((dialog.getByRole('button', { name: 'Copy note' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
