// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// UI parity Task 5: the Projects page. The same core operations as `collab
// project ...`; team controls greyed with the reason (D6); solo works offline.
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });
const row = (over: Record<string, unknown>) => ({
  ulid: 'U', name: 'x', code: 'X', mode: 'solo', team: null, created_at: '', left_at: null, notes: 0, pending: 0, modules: [], ...over,
});
const LIST = () => ({
  projects: [
    row({ ulid: 'u-nv', name: 'Navi', code: 'NV', notes: 3, modules: ['billing'], highest: 4 }),
    row({ ulid: 'u-sh', name: 'Support hub', code: 'SH', mode: 'team', team: 'fp', notes: 9, pending: 2 }),
    row({ ulid: 'u-ol', name: 'Old team', code: 'OL', mode: 'team', team: 'fp', left_at: '2026-10-01' }),
  ],
  modules: ['billing', 'search'],
  office_url: 'https://office:7443',
});
const OWNER = ['note.view', 'project.edit', 'role.manage'];
const overview = (office: string[] | null, shKeys = OWNER) => ({
  connected: true, me: { device_id: 'd-me' },
  office: office ? { role: 'Office member', keys: office } : null,
  projects: [{ ulid: 'u-sh', code: 'SH', name: 'Support hub', role: 'Owner', keys: shKeys }],
});

const api = vi.hoisted(() => ({
  projectsList: vi.fn(), projectCreate: vi.fn(), projectPromote: vi.fn(), projectRename: vi.fn(),
  projectBind: vi.fn(), projectUnbind: vi.fn(), teamOverview: vi.fn(),
}));
vi.mock('../api/client', () => api);

import Projects from './Projects';
import Toaster, { useToasts } from '../components/Toast';

function page(setup?: () => void) {
  api.projectsList.mockResolvedValue(LIST());
  api.teamOverview.mockResolvedValue(overview(['office.project.create']));
  setup?.();
  render(<MemoryRouter><Projects /><Toaster /></MemoryRouter>);
}
const rowOf = async (code: string) => within(await screen.findByRole('row', { name: new RegExp(`\\b${code}\\b`) }));
const dialog = () => within(screen.getByRole('dialog'));
const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

describe('Projects page', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); useToasts.setState({ toasts: [] }); });

  it('lists each project with its mode, notes, waiting notes and bound modules', async () => {
    page();
    const nv = await rowOf('NV');
    nv.getByText('Navi'); nv.getByText('Solo'); nv.getByText('3'); nv.getByText('billing');
    const sh = await rowOf('SH');
    sh.getByText('Team'); sh.getByText('2 waiting for a number');
    (await rowOf('OL')).getByText('Team (left)');
  });

  it('creates a solo project and shows core\'s sentence', async () => {
    page(() => api.projectCreate.mockResolvedValue({ project: {}, lines: ['Created project SC (Scratch), solo: …', 'Use it…'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'Scratch' } });
    fireEvent.change(dialog().getByLabelText('Code'), { target: { value: 'sc' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(api.projectCreate).toHaveBeenCalledWith({ name: 'Scratch', code: 'SC', team: false }));
    await screen.findByText('Created project SC (Scratch), solo: …');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('creates a team project when the office allows it; the office\'s refusal stays in the dialog word for word', async () => {
    const no = 'You need "Create projects" (office.project.create) in this office to do this';
    page(() => api.projectCreate.mockRejectedValue(refusal(403, no)));
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'Team' } });
    fireEvent.change(dialog().getByLabelText('Code'), { target: { value: 'TT' } });
    await waitFor(() => expect(disabled(dialog().getByRole('radio', { name: /Team/ }))).toBe(false));
    fireEvent.click(dialog().getByRole('radio', { name: /Team/ }));
    fireEvent.click(dialog().getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(api.projectCreate).toHaveBeenCalledWith({ name: 'Team', code: 'TT', team: true }));
    expect((await dialog().findByRole('alert')).textContent).toBe(no);
  });

  it('without office.project.create, Team and "Make team project" are greyed with the reason', async () => {
    page(() => api.teamOverview.mockResolvedValue(overview([])));
    const why = 'You need "Create projects" (office.project.create) in this office to do this';
    const nv = await rowOf('NV');
    await waitFor(() => expect(disabled(nv.getByRole('button', { name: 'Make team project' }))).toBe(true));
    nv.getByText(why);
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(disabled(dialog().getByRole('radio', { name: /Team/ }))).toBe(true);
    dialog().getByText(why);
    expect(disabled(dialog().getByRole('radio', { name: /Solo/ }))).toBe(false);
  });

  it('office down: team controls say the office can\'t be reached; solo controls stay usable', async () => {
    page(() => api.teamOverview.mockRejectedValue(refusal(503, "The post office can't be reached right now.")));
    const sh = await rowOf('SH');
    await waitFor(() => expect(disabled(sh.getByRole('button', { name: 'Rename' }))).toBe(true));
    sh.getByText("The post office can't be reached right now.");
    const nv = await rowOf('NV');
    expect(disabled(nv.getByRole('button', { name: 'Rename' }))).toBe(false);
    expect(disabled(nv.getByRole('button', { name: 'Make team project' }))).toBe(true);
    expect(disabled(nv.getByRole('combobox', { name: 'Bind a module to NV' }))).toBe(false);
  });

  it('not connected: solo works; team says the notebook isn\'t connected', async () => {
    page(() => api.teamOverview.mockResolvedValue({ connected: false }));
    const nv = await rowOf('NV');
    await waitFor(() => nv.getByText("This notebook isn't connected to a post office."));
    expect(disabled(nv.getByRole('button', { name: 'Rename' }))).toBe(false);
  });

  it('team rename needs project.edit in that project', async () => {
    page(() => api.teamOverview.mockResolvedValue(overview(['office.project.create'], ['note.view'])));
    const sh = await rowOf('SH');
    await waitFor(() => expect(disabled(sh.getByRole('button', { name: 'Rename' }))).toBe(true));
    sh.getByText('You need "Edit project" (project.edit) in SH to do this');
    (await rowOf('OL')).getByText('This is a team you left: it is read-only.');
  });

  it('rename sends the new name', async () => {
    page(() => api.projectRename.mockResolvedValue({ project: { code: 'NV', name: 'Navigator' } }));
    fireEvent.click((await rowOf('NV')).getByRole('button', { name: 'Rename' }));
    fireEvent.change(dialog().getByLabelText('New name'), { target: { value: 'Navigator' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(api.projectRename).toHaveBeenCalledWith('NV', 'Navigator'));
    await screen.findByText('Project NV is now named Navigator.');
  });

  it('promote asks first, explaining what changes, with the next number', async () => {
    page(() => api.projectPromote.mockResolvedValue({ project: { code: 'NV' }, next: 'NV-5' }));
    const nv = await rowOf('NV');
    await waitFor(() => expect(disabled(nv.getByRole('button', { name: 'Make team project' }))).toBe(false));
    fireEvent.click(nv.getByRole('button', { name: 'Make team project' }));
    const text = dialog().getByText(/^Make NV a team project\?/).textContent!;
    expect(text).toContain('Its notes keep their numbers; new notes continue after NV-4 at the post office https://office:7443.');
    expect(text).toContain('You become its Owner, and only members you add can see it.');
    expect(text).toContain("A team project can't be made solo again.");
    expect(api.projectPromote).not.toHaveBeenCalled();
    fireEvent.click(dialog().getByRole('button', { name: 'Make team project' }));
    await waitFor(() => expect(api.projectPromote).toHaveBeenCalledWith('NV'));
    await screen.findByText('Project NV is now a team project; the next note is NV-5.');
  });

  it('bind and unbind show core\'s line; a left project can\'t be bound to', async () => {
    page(() => {
      api.projectBind.mockResolvedValue({ line: 'Module search is bound to NV: its new notes go to NV.' });
      api.projectUnbind.mockResolvedValue({ line: 'Module billing is no longer bound to NV.' });
    });
    const nv = await rowOf('NV');
    fireEvent.change(nv.getByRole('combobox', { name: 'Bind a module to NV' }), { target: { value: 'search' } });
    fireEvent.click(nv.getByRole('button', { name: 'Bind' }));
    await waitFor(() => expect(api.projectBind).toHaveBeenCalledWith('search', 'NV'));
    await screen.findByText('Module search is bound to NV: its new notes go to NV.');
    fireEvent.click(nv.getByRole('button', { name: 'Unbind billing from NV' }));
    await waitFor(() => expect(api.projectUnbind).toHaveBeenCalledWith('billing'));
    await screen.findByText('Module billing is no longer bound to NV.');
    expect(disabled((await rowOf('OL')).getByRole('combobox', { name: 'Bind a module to OL' }))).toBe(true);
  });
});
