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
  copy_modules: ['billing', 'search'],
  office_url: 'https://office:7443',
  me: 'naveen',
});
const OWNER = ['note.view', 'project.edit', 'role.manage'];
const overview = (office: string[] | null, shKeys = OWNER) => ({
  connected: true, me: { device_id: 'd-me' },
  office: office ? { role: 'Office member', keys: office } : null,
  projects: [{ ulid: 'u-sh', code: 'SH', name: 'Support hub', role: 'Owner', keys: shKeys }],
});

const api = vi.hoisted(() => ({
  projectsList: vi.fn(), projectCreate: vi.fn(), projectPromote: vi.fn(), projectRename: vi.fn(),
  projectBind: vi.fn(), projectUnbind: vi.fn(), teamOverview: vi.fn(), copyPlan: vi.fn(), copyApply: vi.fn(),
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

  it('lists E as emp1st (E) shared with its members', async () => {
    page(() => api.projectsList.mockResolvedValue({
      ...LIST(), eAdopted: true, projects: [row({ ulid: 'u-e', name: 'emp1st', code: 'E', mode: 'team', team: 'fp', notes: 40 }), ...LIST().projects],
    }));
    const e = await rowOf('E');
    e.getByText('emp1st (E) · shared with its members');
    expect(e.queryByText('Solo')).toBeNull();
  });

  it('not adopted: an E row keeps its plain name', async () => {
    page(() => api.projectsList.mockResolvedValue({
      ...LIST(), projects: [row({ ulid: 'u-e', name: 'emp1st', code: 'E', notes: 40 }), ...LIST().projects],
    }));
    const e = await rowOf('E');
    e.getByText('emp1st');
    expect(e.queryByText(/shared with its members/)).toBeNull();
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
    page(() => api.projectRename.mockResolvedValue({ project: { code: 'NV', name: 'Navigator' }, line: 'Project NV is now named Navigator.' }));
    fireEvent.click((await rowOf('NV')).getByRole('button', { name: 'Rename' }));
    fireEvent.change(dialog().getByLabelText('New name'), { target: { value: 'Navigator' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(api.projectRename).toHaveBeenCalledWith('NV', 'Navigator'));
    await screen.findByText('Project NV is now named Navigator.');
  });

  it('promote asks first, explaining what changes, with the next number', async () => {
    page(() => api.projectPromote.mockResolvedValue({ project: { code: 'NV' }, next: 'NV-5', lines: ['Project NV (Navi) is now a team project: the next note is NV-5.'] }));
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
    await screen.findByText('Project NV (Navi) is now a team project: the next note is NV-5.');
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

  it('promote: a project with no notes starts at CODE-1; an already-team answer says so', async () => {
    page(() => {
      api.projectsList.mockResolvedValue({ ...LIST(), projects: [row({ ulid: 'u-em', name: 'Empty', code: 'EM', highest: 0 })] });
      api.projectPromote.mockResolvedValue({ project: { code: 'EM' }, already: true, lines: ["Project EM (Empty) is already a team project of this notebook's post office."] });
    });
    const em = await rowOf('EM');
    await waitFor(() => expect(disabled(em.getByRole('button', { name: 'Make team project' }))).toBe(false));
    fireEvent.click(em.getByRole('button', { name: 'Make team project' }));
    dialog().getByText(/Its notes keep their numbers; new notes start at EM-1 at the post office/);
    fireEvent.click(dialog().getByRole('button', { name: 'Make team project' }));
    await screen.findByText("Project EM (Empty) is already a team project of this notebook's post office.");
    expect(api.projectsList).toHaveBeenCalledTimes(2);
  });

  it('dialog: Escape and Cancel close it and nothing is sent; focus starts in the first field', async () => {
    page();
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    expect(document.activeElement).toBe(dialog().getByLabelText('Name'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.projectCreate).not.toHaveBeenCalled();
  });

  it('dialog: while a request runs, Escape does not close it and the button can\'t be pressed twice', async () => {
    let finish: (v: unknown) => void = () => {};
    page(() => api.projectRename.mockReturnValue(new Promise((r) => { finish = r; })));
    fireEvent.click((await rowOf('NV')).getByRole('button', { name: 'Rename' }));
    fireEvent.change(dialog().getByLabelText('New name'), { target: { value: 'Navigator' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(disabled(dialog().getByRole('button', { name: 'Working…' }))).toBe(true));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    screen.getByRole('dialog');
    fireEvent.click(dialog().getByRole('button', { name: 'Working…' }));
    expect(api.projectRename).toHaveBeenCalledTimes(1);
    finish({ project: { code: 'NV', name: 'Navigator' }, line: 'Project NV is now named Navigator.' });
    await screen.findByText('Project NV is now named Navigator.');
  });

  it('while the office answers, team controls say so', async () => {
    page(() => api.teamOverview.mockReturnValue(new Promise(() => {})));
    (await rowOf('NV')).getByText('Checking the post office…');
  });

  const PLAN = (titles: string[]) => ({
    source: { kind: 'module', name: 'billing', label: 'module billing (E notes)' },
    target: { ulid: 'u-nv', code: 'NV', name: 'Navi', mode: 'solo' },
    items: titles.map((t, i) => ({ ulid: `n${i}`, ref: `E-0000${i + 1}`, type: 'decision', title: t, author: 'naveen', created_at: '2026-10-01' })),
    skipped: [],
    lines: [`Copy ${titles.length} notes from module billing (E notes) into NV (Navi, solo):`],
  });

  it('copy: pick a source, see the list, confirm, copy exactly that list', async () => {
    page(() => {
      api.copyPlan.mockResolvedValue(PLAN(['first', 'second']));
      api.copyApply.mockResolvedValue({ copied: [{}, {}], lines: ['Copied 2 notes from module billing (E notes) into NV (Navi, solo):', '  E-00001 -> NV-5'] });
    });
    fireEvent.click((await rowOf('NV')).getByRole('button', { name: 'Copy notes here' }));
    const from = dialog().getByLabelText('Copy from') as HTMLSelectElement;
    expect([...from.options].map((o) => o.textContent)).toEqual([
      'Choose a module or project…', 'Module billing (its notes with no project)', 'Module search (its notes with no project)',
      'Project SH · Support hub', 'Project OL · Old team',
    ]);
    fireEvent.change(from, { target: { value: 'module:billing' } });
    fireEvent.click(dialog().getByLabelText('Only my notes (by naveen)'));
    fireEvent.click(dialog().getByRole('button', { name: 'Show the notes' }));
    await waitFor(() => expect(api.copyPlan).toHaveBeenCalledWith({ from: 'module:billing', to: 'NV', author: 'me' }));
    const items = within(await dialog().findByRole('list', { name: 'Notes to copy' }));
    items.getByText('first'); items.getByText('second');
    expect(api.copyApply).not.toHaveBeenCalled();
    fireEvent.click(dialog().getByRole('button', { name: 'Copy 2 notes' }));
    await waitFor(() => expect(api.copyApply).toHaveBeenCalledWith({ from: 'module:billing', to: 'NV', author: 'me' }, ['n0', 'n1'], 'u-nv'));
    const done = await screen.findByText(/^Copied 2 notes from module billing \(E notes\) into NV \(Navi, solo\):/);
    expect(done.textContent).toContain('E-00001 -> NV-5');
  });

  it('copy: a changed list is refused and the new list is shown; a refusal stays in the dialog', async () => {
    const changed = 'The notes changed since the list was shown; nothing was copied. Check the list again.';
    page(() => {
      api.copyPlan.mockResolvedValueOnce(PLAN(['first'])).mockResolvedValueOnce(PLAN(['first', 'late']));
      api.copyApply.mockRejectedValueOnce(refusal(409, changed));
    });
    fireEvent.click((await rowOf('NV')).getByRole('button', { name: 'Copy notes here' }));
    fireEvent.change(dialog().getByLabelText('Copy from'), { target: { value: 'module:billing' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Show the notes' }));
    fireEvent.click(await dialog().findByRole('button', { name: 'Copy 1 note' }));
    expect((await dialog().findByRole('alert')).textContent).toBe(changed);
    await dialog().findByRole('button', { name: 'Copy 2 notes' });
    within(dialog().getByRole('list', { name: 'Notes to copy' })).getByText('late');
  });

  it('copy: changing the source drops the list on screen; a left project can\'t be copied into', async () => {
    page(() => api.copyPlan.mockResolvedValue(PLAN(['first'])));
    expect(disabled((await rowOf('OL')).getByRole('button', { name: 'Copy notes here' }))).toBe(true);
    fireEvent.click((await rowOf('NV')).getByRole('button', { name: 'Copy notes here' }));
    fireEvent.change(dialog().getByLabelText('Copy from'), { target: { value: 'module:billing' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Show the notes' }));
    await dialog().findByRole('button', { name: 'Copy 1 note' });
    fireEvent.change(dialog().getByLabelText('Copy from'), { target: { value: 'module:search' } });
    dialog().getByRole('button', { name: 'Show the notes' });
    expect(dialog().queryByRole('list', { name: 'Notes to copy' })).toBeNull();
  });
});
