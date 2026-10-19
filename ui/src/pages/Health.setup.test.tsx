// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  doctor: vi.fn(async () => ({ ok: true, checks: [] })),
  modules: vi.fn(async () => ({ results: [{ slug: 'billing' }] })),
  reassignModule: vi.fn(),
  upsertEntry: vi.fn(),
  setupDoctor: vi.fn(async () => ({
    checks: [{ group: 'install', id: 'install.addon', mark: 'error', text: 'Sync add-on missing', fix: 'collab doctor --fix' }],
    errors: 1, warnings: 0, exitCode: 2, notebook: null, fixable: ['install.addon'],
  })),
  doctorFix: vi.fn(),
  notebooksList: vi.fn(async () => ({
    open: { name: 'main', path: '/data/main/notebook.db', described: 'notebook main (the default)' },
    notebooks: [
      { name: 'main', path: '/data/main/notebook.db', default: true, open: true, missing: false },
      { name: 'old', path: '/data/old.db', default: false, open: false, missing: true },
    ],
  })),
}));
vi.mock('../api/client', () => api);

import Health from './Health';
import Toaster from '../components/Toast';
import { fireEvent, within } from '@testing-library/react';

describe('Health page: setup report', () => {
  afterEach(() => cleanup());

  it('shows each problem with its fix in a code element, and the same summary as the terminal', async () => {
    render(<MemoryRouter><Health /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Sync add-on missing')).toBeTruthy());
    const fix = screen.getByText('collab doctor --fix');
    expect(fix.tagName).toBe('CODE');
    expect(screen.getByText('1 problem(s), 0 warning(s).')).toBeTruthy();
  });

  it('a fixable check has a Fix button running core\'s safe repair; --fix\'s line is shown and the report refreshes', async () => {
    api.doctorFix.mockResolvedValue({ ok: true, text: 'fixed: sync add-on', report: { checks: [{ group: 'install', id: 'install.addon', mark: 'ok', text: 'Sync add-on installed' }], errors: 0, warnings: 0, exitCode: 0, notebook: null, fixable: [] } });
    render(<MemoryRouter><Health /><Toaster /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix' }));
    await waitFor(() => expect(api.doctorFix).toHaveBeenCalledWith('install.addon'));
    await screen.findByText('fixed: sync add-on');
    await screen.findByText('Sync add-on installed');
    expect(screen.queryByRole('button', { name: 'Fix' })).toBeNull();
  });

  it('lists the notebooks, marking the open one, the default and a missing file', async () => {
    render(<MemoryRouter><Health /></MemoryRouter>);
    await screen.findByText(/Open now: notebook main \(the default\)/);
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('/data/'));
    expect(within(items[0]).getByText('Open')).toBeTruthy();
    expect(within(items[0]).getByText('Default')).toBeTruthy();
    expect(within(items[1]).getByText('File missing')).toBeTruthy();
  });

  it('a failed fix shows --fix\'s line as an error that stays; a refused one reloads the report', async () => {
    api.doctorFix.mockResolvedValueOnce({ ok: false, text: 'could not fix: sync add-on (offline)', report: { checks: [], errors: 0, warnings: 0, exitCode: 0, notebook: null, fixable: [] } });
    render(<MemoryRouter><Health /><Toaster /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix' }));
    expect((await screen.findByRole('alert')).textContent).toContain('could not fix: sync add-on (offline)');
    cleanup();
    api.doctorFix.mockRejectedValueOnce(Object.assign(new Error('Nothing to fix: the check is fine now.'), { status: 409 }));
    const before = api.setupDoctor.mock.calls.length;
    render(<MemoryRouter><Health /><Toaster /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix' }));
    await screen.findAllByText('Nothing to fix: the check is fine now.');
    await waitFor(() => expect(api.setupDoctor.mock.calls.length).toBe(before + 2));
  });

  it('bulk reassign and fix summary use dialogs, not browser prompts (UI parity Task 12)', async () => {
    api.doctor.mockResolvedValue({ ok: false, checks: [
      { name: 'Notes without a module', severity: 'warn', detail: 'd', items: [{ id: 4, title: 'Loose' }] },
      { name: 'Missing summary', severity: 'warn', detail: 'd', items: [{ id: 5, title: 'Short' }] },
    ] } as any);
    api.reassignModule.mockResolvedValue({ ok: true });
    api.upsertEntry.mockResolvedValue({ ok: true });
    render(<MemoryRouter><Health /><Toaster /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Bulk Reassign 1 Entries/i }));
    let dialog = within(screen.getByRole('dialog'));
    await waitFor(() => expect((dialog.getByLabelText('Module') as HTMLSelectElement).options.length).toBe(2));
    fireEvent.change(dialog.getByLabelText('Module'), { target: { value: 'billing' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(api.reassignModule).toHaveBeenCalledWith([4], 'billing'));
    fireEvent.click(within((await screen.findByText('Short')).closest('tr')!).getByRole('button', { name: 'Fix' }));
    dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Summary'), { target: { value: 'x'.repeat(201) } });
    expect((dialog.getByRole('button', { name: 'Save summary' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText('Summary'), { target: { value: 'A real summary' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save summary' }));
    await waitFor(() => expect(api.upsertEntry).toHaveBeenCalledWith({ id: 5, summary: 'A real summary' }));
  });
});
