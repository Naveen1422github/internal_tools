// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// UI parity Task 7c: share and stop sharing a module, as `collab sync share|unshare`.
const api = vi.hoisted(() => ({
  modules: vi.fn(),
  moduleCard: vi.fn(),
  moduleShare: vi.fn(),
  teamOverview: vi.fn(),
}));
vi.mock('../api/client', () => api);

import Modules from './Modules';
import Toaster, { useToasts } from '../components/Toast';

const office = (keys: string[]) => ({ connected: true, me: { device_id: 'd' }, office: { role: 'X', keys }, projects: [] });
function page(setup?: () => void) {
  api.modules.mockResolvedValue({ results: [{ slug: 'ledger', name: 'Ledger', status: 'active', shared: false }] });
  api.moduleCard.mockResolvedValue({ module: { slug: 'ledger', name: 'Ledger', goal: 'g' } });
  api.teamOverview.mockResolvedValue(office(['office.module.share']));
  setup?.();
  render(<MemoryRouter><Modules /><Toaster /></MemoryRouter>);
}
const open = async () => fireEvent.click(await screen.findByRole('button', { name: /Ledger/ }));
const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

describe('Modules page: share with the team', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); useToasts.setState({ toasts: [] }); });

  it('shares and stops sharing through the office; the list follows its answer', async () => {
    page(() => api.moduleShare.mockResolvedValueOnce({ shared: ['ledger'] }).mockResolvedValueOnce({ shared: [] }));
    await open();
    const share = await screen.findByRole('button', { name: 'Share with the team' });
    await waitFor(() => expect(disabled(share)).toBe(false));
    fireEvent.click(share);
    await waitFor(() => expect(api.moduleShare).toHaveBeenCalledWith('ledger', true));
    await screen.findByText('ledger is now shared with the whole team.');
    fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(api.moduleShare).toHaveBeenCalledWith('ledger', false));
  });

  it('without office.module.share: greyed with the office\'s sentence', async () => {
    page(() => api.teamOverview.mockResolvedValue(office([])));
    await open();
    const share = await screen.findByRole('button', { name: 'Share with the team' });
    await screen.findByText('You need "Share modules" (office.module.share) in this office to do this');
    expect(disabled(share)).toBe(true);
  });

  it('the starter Office admin may share although the retired key is no longer in its keys (local-first Task 5)', async () => {
    page(() => api.teamOverview.mockResolvedValue({ ...office(['office.project.create']), office: { role: 'Office admin', keys: ['office.project.create'] } }));
    await open();
    const share = await screen.findByRole('button', { name: 'Share with the team' });
    await waitFor(() => expect(disabled(share)).toBe(false));
  });

  it('an office refusal is shown word for word; a notebook that doesn\'t share has no button', async () => {
    page(() => api.moduleShare.mockRejectedValue(Object.assign(new Error("The post office can't be reached right now."), { status: 503 })));
    await open();
    const share = await screen.findByRole('button', { name: 'Share with the team' });
    await waitFor(() => expect(disabled(share)).toBe(false));
    fireEvent.click(share);
    expect((await screen.findByRole('alert')).textContent).toContain("The post office can't be reached right now.");
    cleanup();
    page(() => api.modules.mockResolvedValue({ results: [{ slug: 'ledger', name: 'Ledger', status: 'active' }] }));
    await open();
    await screen.findByText('g');
    expect(screen.queryByRole('button', { name: 'Share with the team' })).toBeNull();
  });

  it('sent anyway, the office\'s 403 sentence is shown; a module bound to a project says its notes follow the project', async () => {
    const no = 'You need "Share modules" (office.module.share) in this office to do this';
    page(() => {
      api.modules.mockResolvedValue({ results: [{ slug: 'ledger', name: 'Ledger', status: 'active', shared: true, bound_project: 'SH' }] });
      api.moduleShare.mockRejectedValue(Object.assign(new Error(no), { status: 403 }));
    });
    await open();
    await screen.findByText(/This module is bound to SH: its new notes go to SH and follow that project, not this switch/);
    const stop = await screen.findByRole('button', { name: 'Stop sharing' });
    await waitFor(() => expect(disabled(stop)).toBe(false));
    fireEvent.click(stop);
    expect((await screen.findByRole('alert')).textContent).toContain(no);
  });

  it('not adopted: the old toggle still renders and there is no Project line', async () => {
    page(() => api.modules.mockResolvedValue({ eAdopted: false, results: [{ slug: 'ledger', name: 'Ledger', status: 'active', shared: false }] }));
    await open();
    await screen.findByRole('button', { name: 'Share with the team' });
    expect(screen.queryByText(/^Project:/)).toBeNull();
  });

  it('adopted: no share toggle or shared badge; each module shows its project code or a dash', async () => {
    page(() => api.modules.mockResolvedValue({ eAdopted: true, results: [
      { slug: 'ledger', name: 'Ledger', status: 'active', shared: true, project: 'SH' },
      { slug: 'other', name: 'Other', status: 'active', project: null },
    ] }));
    await open();
    await screen.findByText('g');
    expect(screen.queryByRole('button', { name: 'Share with the team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop sharing' })).toBeNull();
    expect(screen.queryByText('⇄ Shared with team')).toBeNull();
    expect(screen.getByText('Project: SH')).toBeTruthy();
    expect(screen.getByText('Project: –')).toBeTruthy();
    expect(api.teamOverview).not.toHaveBeenCalled();
  });
});
