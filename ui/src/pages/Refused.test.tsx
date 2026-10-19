// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// RnR S3 (Task 9, S3-10): this laptop's refused changes. Copy and delete are the
// CLI's actions; the page shows the reason and any refusal word for word.
const REASON = 'You need "Edit any note" (note.edit.any) in SH to do this';
const rows = () => [
  { id: 'r1', at: '2026-10-19 10:00:00', project_code: 'SH', kind: 'edit' as const, key: 'note.edit.any', reason: REASON, note: 'SH-7' },
  { id: 'r2', at: '2026-10-19 11:00:00', project_code: 'SH', kind: 'new' as const, key: 'note.create', reason: 'Another reason', note: 'MY-3' },
];
const SOLO = [{ code: 'MY', name: 'Mine' }, { code: 'PR', name: 'Private' }];
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });

const api = vi.hoisted(() => ({
  refusedList: vi.fn(),
  refusedCopy: vi.fn(),
  refusedDelete: vi.fn(),
  needsMerge: vi.fn(),
  teamOverview: vi.fn(),
  RELOAD_MESSAGE: 'reload',
}));
vi.mock('../api/client', () => api);

import Refused from './Refused';
import Sidebar from '../components/Sidebar';

function page(setup?: () => void) {
  api.refusedList.mockResolvedValue({ results: rows(), solo_projects: SOLO });
  api.refusedCopy.mockResolvedValue({ ref: 'MY-4' });
  api.refusedDelete.mockResolvedValue({ ok: true });
  setup?.();
  render(<MemoryRouter initialEntries={['/refused']}><Routes><Route path="/refused" element={<Refused />} /></Routes></MemoryRouter>);
}
const rowOf = async (text: string) => within(await screen.findByRole('row', { name: new RegExp(text) }));

describe('Refused changes page', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('shows the intro, the columns, and each row with its reason verbatim', async () => {
    page();
    await screen.findByText('The post office turned down these changes. They are kept on this laptop only.');
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads.slice(0, 5)).toEqual(['When', 'Project', 'Kind', 'Note', 'Reason']);
    const edit = await rowOf('SH-7');
    edit.getByText(REASON);
    edit.getByText('Edit');
    edit.getByText(new Date('2026-10-19T10:00:00Z').toLocaleString());
    const created = await rowOf('MY-3');
    created.getByText('New note');
    created.getByText('Another reason');
  });

  it('Copy calls refusedCopy(id, code), shows the new ref and the row disappears', async () => {
    page(() => api.refusedList
      .mockResolvedValueOnce({ results: rows(), solo_projects: SOLO })
      .mockResolvedValueOnce({ results: rows().slice(1), solo_projects: SOLO }));
    const row = await rowOf('SH-7');
    const select = row.getByRole('combobox', { name: 'Copy to a solo project' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['MY · Mine', 'PR · Private']);
    fireEvent.change(select, { target: { value: 'PR' } });
    fireEvent.click(row.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(api.refusedCopy).toHaveBeenCalledWith('r1', 'PR'));
    await screen.findByText('Copied as MY-4.');
    await waitFor(() => expect(screen.queryByRole('row', { name: /SH-7/ })).toBeNull());
    expect(api.refusedList).toHaveBeenCalledTimes(2);
    await rowOf('MY-3');
  });

  it('each row keeps its own copy target', async () => {
    page();
    const second = await rowOf('MY-3');
    fireEvent.change(second.getByRole('combobox'), { target: { value: 'PR' } });
    fireEvent.click((await rowOf('SH-7')).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(api.refusedCopy).toHaveBeenCalledWith('r1', 'MY'));
  });

  it('a refused copy is shown word for word in a banner that can be dismissed', async () => {
    const msg = 'MY is a team project. Copy this note into a solo project instead.';
    page(() => api.refusedCopy.mockRejectedValue(refusal(400, msg)));
    fireEvent.click((await rowOf('SH-7')).getByRole('button', { name: 'Copy' }));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain(msg);
    expect(screen.queryByText(/Copied as/)).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Delete asks first; Cancel calls nothing; Delete in the panel deletes and reloads', async () => {
    page(() => api.refusedList
      .mockResolvedValueOnce({ results: rows(), solo_projects: SOLO })
      .mockResolvedValueOnce({ results: rows().slice(1), solo_projects: SOLO }));
    fireEvent.click((await rowOf('SH-7')).getByRole('button', { name: 'Delete' }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete this refused change? What you typed is removed from this laptop.');
    expect(dialog.textContent).not.toContain('The note is removed too.');
    expect(api.refusedDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.refusedDelete).not.toHaveBeenCalled();

    fireEvent.click((await rowOf('SH-7')).getByRole('button', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.refusedDelete).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(screen.queryByRole('row', { name: /SH-7/ })).toBeNull());
    expect(api.refusedList).toHaveBeenCalledTimes(2);
  });

  it('while a copy is pending, that row\'s Copy and Delete are disabled; other rows are not', async () => {
    let finish!: (v: unknown) => void;
    page(() => api.refusedCopy.mockImplementationOnce(() => new Promise((yes) => { finish = yes; })));
    const row = await rowOf('SH-7');
    const copy = row.getByRole('button', { name: 'Copy' }) as HTMLButtonElement;
    fireEvent.click(copy);
    await waitFor(() => expect(copy.disabled).toBe(true));
    expect((row.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(copy);
    expect(api.refusedCopy).toHaveBeenCalledTimes(1);
    expect(((await rowOf('MY-3')).getByRole('button', { name: 'Copy' }) as HTMLButtonElement).disabled).toBe(false);
    finish({ ref: 'MY-4' });
    await screen.findByText('Copied as MY-4.');
    await waitFor(() => expect(copy.disabled).toBe(false));
  });

  it('while a delete is pending, that row\'s Copy and Delete are disabled', async () => {
    let finish!: (v: unknown) => void;
    page(() => api.refusedDelete.mockImplementationOnce(() => new Promise((yes) => { finish = yes; })));
    const row = await rowOf('SH-7');
    fireEvent.click(row.getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect((row.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true));
    expect((row.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).disabled).toBe(true);
    finish({ ok: true });
    await waitFor(() => expect((row.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a copy that worked is reported even when the reload fails; the reload error is shown separately', async () => {
    page(() => api.refusedList
      .mockResolvedValueOnce({ results: rows(), solo_projects: SOLO })
      .mockRejectedValueOnce(refusal(503, 'The server is not answering.')));
    fireEvent.click((await rowOf('SH-7')).getByRole('button', { name: 'Copy' }));
    await screen.findByText('Copied as MY-4.');
    expect((await screen.findByRole('alert')).textContent).toContain('The server is not answering.');
  });

  it('the delete panel gives focus back to Delete on Cancel, and to the heading after a delete', async () => {
    page(() => api.refusedList
      .mockResolvedValueOnce({ results: rows(), solo_projects: SOLO })
      .mockResolvedValueOnce({ results: rows().slice(1), solo_projects: SOLO }));
    const del = (await rowOf('SH-7')).getByRole('button', { name: 'Delete' });
    fireEvent.click(del);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(del);
    fireEvent.click(del);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('row', { name: /SH-7/ })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Refused changes' }));
  });

  it('deleting a new note says the note is removed too', async () => {
    page();
    fireEvent.click((await rowOf('MY-3')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/^Delete this refused change/).textContent)
      .toBe('Delete this refused change? What you typed is removed from this laptop. The note is removed too.');
  });

  it('with no solo project the Copy select is replaced by the hint', async () => {
    page(() => api.refusedList.mockResolvedValue({ results: rows(), solo_projects: [] }));
    await rowOf('SH-7');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    const code = screen.getByText('collab project create <name>');
    expect(code.tagName).toBe('CODE');
    expect(code.parentElement!.textContent).toBe('Create a solo project first: collab project create <name>.');
  });

  it('with nothing refused it says so, with no hint', async () => {
    page(() => api.refusedList.mockResolvedValue({ results: [], solo_projects: [] }));
    await screen.findByText('Nothing was refused.');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/Create a solo project first/)).toBeNull();
  });
});

describe('Sidebar, Refused changes', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  function sidebar(refused: () => Promise<unknown>) {
    api.needsMerge.mockResolvedValue({ results: [] });
    api.teamOverview.mockResolvedValue({ connected: false });
    api.refusedList.mockImplementation(refused);
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
  }

  it('shows "Refused changes" with the count when there are some', async () => {
    sidebar(async () => ({ results: rows(), solo_projects: [] }));
    const link = await screen.findByRole('link', { name: /Refused changes/ });
    expect(link.getAttribute('href')).toBe('/refused');
    expect(link.textContent).toBe('Refused changes2');
  });

  it('is hidden when nothing was refused', async () => {
    sidebar(async () => ({ results: [], solo_projects: [] }));
    await waitFor(() => expect(api.refusedList).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole('link', { name: /Refused changes/ })).toBeNull();
  });

  it('is hidden when the list cannot be read', async () => {
    sidebar(async () => { throw new Error('down'); });
    await waitFor(() => expect(api.refusedList).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole('link', { name: /Refused changes/ })).toBeNull();
  });
});

describe('Sidebar, Team', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

  it('asks for the team overview again every 30 s, so "Team" appears once the office is reachable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.needsMerge.mockResolvedValue({ results: [] });
    api.refusedList.mockResolvedValue({ results: [], solo_projects: [] });
    api.teamOverview
      .mockRejectedValueOnce(refusal(503, "The post office can't be reached right now."))
      .mockResolvedValue({ connected: true, me: { device_id: 'd' }, office: null, projects: [{ ulid: 'P', code: 'SH', name: null, role: 'Reader', keys: [] }] });
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    await waitFor(() => expect(api.teamOverview).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('link', { name: 'Team' })).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await screen.findByRole('link', { name: 'Team' })).getAttribute('href')).toBe('/team');
    expect(api.teamOverview).toHaveBeenCalledTimes(2);
  });
});
