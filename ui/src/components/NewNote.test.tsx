// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';

// UI parity Task 9 (A): write a note yourself, seeing where it lands before saving.
const api = vi.hoisted(() => ({
  modules: vi.fn(),
  projectsList: vi.fn(),
  noteDestination: vi.fn(),
  upsertEntry: vi.fn(),
}));
vi.mock('../api/client', () => api);

import NewNote from './NewNote';
import Toaster, { useToasts } from './Toast';
import { useUi } from '../store/ui';

const line = (code: string | null, why = 'named') => ({
  project: code ? { code, name: code === 'NV' ? 'Navi' : 'Team', mode: code === 'NV' ? 'solo' : 'team' } : null, why,
  line: code ? `It goes into ${code}.` : 'It goes into no project: it is numbered in the E series (E-…).',
});
function form(setup?: () => void) {
  api.modules.mockResolvedValue({ results: [{ slug: 'billing' }] });
  api.projectsList.mockResolvedValue({ projects: [
    { ulid: 'u1', code: 'NV', name: 'Navi', mode: 'solo', left_at: null },
    { ulid: 'u2', code: 'OL', name: 'Old', mode: 'team', left_at: '2026-10-01' },
  ] });
  api.noteDestination.mockImplementation(async (p: { module?: string; project?: string }) =>
    p.project === 'NV' ? line('NV') : p.module === 'billing' ? { ...line('NV', 'bound'), line: 'It goes into NV (Navi) because module billing is bound to NV.' } : line(null, 'none'));
  setup?.();
  useUi.setState({ newNoteOpen: true });
  render(<><NewNote /><Toaster /></>);
}
const dialog = () => within(screen.getByRole('dialog'));
const fill = () => {
  fireEvent.change(dialog().getByLabelText('Title'), { target: { value: 'Pick the queue' } });
  fireEvent.change(dialog().getByLabelText('Summary'), { target: { value: 'We use SQS.' } });
};

describe('New note form', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); useToasts.setState({ toasts: [] }); });

  it('says where the note lands as the module and project change; left projects are not offered', async () => {
    form();
    await dialog().findByText('It goes into no project: it is numbered in the E series (E-…).');
    fireEvent.change(dialog().getByLabelText('Module'), { target: { value: 'billing' } });
    await dialog().findByText('It goes into NV (Navi) because module billing is bound to NV.');
    const proj = dialog().getByLabelText('Project') as HTMLSelectElement;
    await waitFor(() => expect([...proj.options].map((o) => o.textContent)).toEqual(['Automatic (from the module)', 'NV · Navi', 'No project (E series)']));
    fireEvent.change(proj, { target: { value: 'NV' } });
    await waitFor(() => expect(api.noteDestination).toHaveBeenLastCalledWith({ module: 'billing', project: 'NV' }));
  });

  it('saves with the chosen project, then opens the new note and says its number', async () => {
    form(() => api.upsertEntry.mockResolvedValue({ ok: true, id: 12, series: 'NV' }));
    fill();
    await waitFor(() => expect((dialog().getByLabelText('Project') as HTMLSelectElement).options.length).toBe(3));
    fireEvent.change(dialog().getByLabelText('Project'), { target: { value: 'NV' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(api.upsertEntry).toHaveBeenCalledWith({ type: 'decision', title: 'Pick the queue', summary: 'We use SQS.', description: undefined, module: undefined, project: 'NV' }));
    await screen.findByText('Saved as NV-12.');
    expect(useUi.getState().newNoteOpen).toBe(false);
    expect(useUi.getState().drawerEntry).toEqual({ ref: 'NV-12' });
  });

  it('"Automatic" sends no project: core decides, as for the AI', async () => {
    form(() => api.upsertEntry.mockResolvedValue({ ok: true, id: 3, series: 'E' }));
    fill();
    fireEvent.click(dialog().getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(api.upsertEntry).toHaveBeenCalled());
    expect('project' in api.upsertEntry.mock.calls[0][0]).toBe(false);
  });

  it('validates like the draft card; a role refusal stays in the form word for word', async () => {
    const no = 'You need "Create notes" (note.create) in TM to do this';
    form(() => api.upsertEntry.mockRejectedValue(Object.assign(new Error(no), { status: 403 })));
    fireEvent.click(dialog().getByRole('button', { name: 'Save note' }));
    expect((await dialog().findByRole('alert')).textContent).toBe('title is required; summary is required');
    expect(api.upsertEntry).not.toHaveBeenCalled();
    fill();
    fireEvent.click(dialog().getByRole('button', { name: 'Save note' }));
    expect((await dialog().findByRole('alert')).textContent).toBe(no);
    screen.getByRole('dialog');
  });
});
