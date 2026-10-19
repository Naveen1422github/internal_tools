// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// RnR S3 (Task 6): the Team page and its Members tab. The office decides; the
// page asks, shows its answer word for word, and disables what the viewer's keys rule out.
const ALL_PROJECT = ['note.view', 'note.create', 'note.edit.own', 'note.edit.any', 'note.supersede', 'note.archive',
  'note.copy.out', 'merge.resolve', 'project.edit', 'member.invite', 'member.revoke', 'role.manage', 'ai_limits.manage'];
const ALL_OFFICE = ['office.project.create', 'office.module.share', 'office.member.add', 'office.member.revoke',
  'office.role.manage', 'module.create', 'module.edit'];

const overview = () => ({
  connected: true as const,
  me: { device_id: 'dev-me' },
  office: { role: 'Office admin', keys: ALL_OFFICE },
  projects: [
    { ulid: 'P_SH', code: 'SH', name: 'Shop', role: 'Owner', keys: ALL_PROJECT },
    { ulid: 'P_RD', code: 'RD', name: 'Research', role: 'Reader', keys: ['note.view'] },
  ],
});
const role = (ulid: string, name: string, keys: string[], locked: 'all' | 'name' | null = null) =>
  ({ ulid, name, keys, is_starter: true, locked });
const projectRoster = () => ({
  members: [
    { device_id: 'dev-me', name: 'Naveen', role: 'Owner', role_ulid: 'r-owner', last_seen_at: '2026-10-19 10:00:00' },
    { device_id: 'dev-r', name: 'Rinku', role: 'Contributor', role_ulid: 'r-contrib', last_seen_at: null },
  ],
  roles: [role('r-owner', 'Owner', ALL_PROJECT, 'all'), role('r-contrib', 'Contributor', ['note.view']), role('r-reader', 'Reader', ['note.view'])],
});
const officeRoster = () => ({
  members: [
    { device_id: 'dev-me', name: 'Naveen', role: 'Office admin', role_ulid: 'o-admin', last_seen_at: null },
    { device_id: 'dev-r', name: 'Rinku', role: 'Office member', role_ulid: 'o-member', last_seen_at: null },
  ],
  roles: [role('o-admin', 'Office admin', ALL_OFFICE, 'all'), role('o-member', 'Office member', ['office.project.create'], 'name')],
});
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });

const api = vi.hoisted(() => ({
  teamOverview: vi.fn(),
  teamProject: vi.fn(),
  teamOffice: vi.fn(),
  teamSetMember: vi.fn(),
  teamRemoveMember: vi.fn(),
  RELOAD_MESSAGE: 'reload',
}));
vi.mock('../api/client', () => api);

import Team from './Team';

/** Default answers, then `setup` overrides some, then render /team at `path`. */
function at(path: string, setup?: () => void) {
  api.teamOverview.mockResolvedValue(overview());
  api.teamProject.mockResolvedValue(projectRoster());
  api.teamOffice.mockResolvedValue(officeRoster());
  api.teamSetMember.mockResolvedValue({ ok: true });
  api.teamRemoveMember.mockResolvedValue({ ok: true });
  setup?.();
  render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/team" element={<Team />} /></Routes></MemoryRouter>);
}
const rowOf = async (name: string) => within(await screen.findByRole('row', { name: new RegExp(name) }));

describe('Team page, Members tab', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('the picker lists each team project as "CODE · Name", plus Office; tabs are shown', async () => {
    at('/team');
    const picker = await screen.findByLabelText('Team settings for') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(['SH · Shop', 'RD · Research', 'Office']);
    expect(picker.value).toBe('SH');
    for (const t of ['Members', 'Roles', 'Who can do what']) screen.getByRole('tab', { name: t });
    await waitFor(() => expect(api.teamProject).toHaveBeenCalledWith('P_SH'));
  });

  it('no Office entry when the viewer holds no office role', async () => {
    at('/team', () => api.teamOverview.mockResolvedValue({ ...overview(), office: null }));
    const picker = await screen.findByLabelText('Team settings for') as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(2));
    expect([...picker.options].map((o) => o.textContent)).toEqual(['SH · Shop', 'RD · Research']);
  });

  it('lists members with "You" on the viewer\'s own row', async () => {
    at('/team?scope=SH');
    const me = await rowOf('Naveen');
    me.getByText('You');
    // The office's SQLite time is UTC.
    me.getByText(new Date('2026-10-19T10:00:00Z').toLocaleString());
    const rinku = await rowOf('Rinku');
    expect(rinku.queryByText('You')).toBeNull();
    rinku.getByText('Never');
  });

  it('changing a role calls teamSetMember with the device and role name at once, then reloads', async () => {
    at('/team?scope=SH');
    const select = (await rowOf('Rinku')).getByLabelText('Role for Rinku') as HTMLSelectElement;
    expect(select.value).toBe('Contributor');
    fireEvent.change(select, { target: { value: 'Reader' } });
    await waitFor(() => expect(api.teamSetMember).toHaveBeenCalledWith({ scope: 'project', project: 'P_SH', device: 'dev-r', role: 'Reader' }));
    await waitFor(() => expect(api.teamProject).toHaveBeenCalledTimes(2));
    expect(api.teamOverview).toHaveBeenCalledTimes(2);
  });

  it('an office refusal is shown word for word in a banner that can be dismissed', async () => {
    at('/team?scope=SH');
    const msg = 'You need "Edit project" (project.edit) in SH to do this';
    api.teamSetMember.mockRejectedValueOnce(refusal(403, msg));
    fireEvent.change((await rowOf('Rinku')).getByLabelText('Role for Rinku'), { target: { value: 'Reader' } });
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain(msg);
    // The select still shows the real role, not the refused one.
    expect(((await rowOf('Rinku')).getByLabelText('Role for Rinku') as HTMLSelectElement).value).toBe('Contributor');
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('remove asks first; Cancel does nothing; Remove calls teamRemoveMember', async () => {
    at('/team?scope=SH');
    fireEvent.click((await rowOf('Rinku')).getByRole('button', { name: 'Remove from SH' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm.textContent).toContain("Remove Rinku from SH? They keep a read-only copy of the project's notes and receive nothing new.");
    expect(api.teamRemoveMember).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.teamRemoveMember).not.toHaveBeenCalled();

    fireEvent.click((await rowOf('Rinku')).getByRole('button', { name: 'Remove from SH' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.teamRemoveMember).toHaveBeenCalledWith({ project: 'P_SH', device: 'dev-r' }));
    await waitFor(() => expect(api.teamProject).toHaveBeenCalledTimes(2));
  });

  it('without role.manage or member.revoke the controls are disabled with the standard sentence', async () => {
    at('/team?scope=RD');
    await waitFor(() => expect(api.teamProject).toHaveBeenCalledWith('P_RD'));
    const rinku = await rowOf('Rinku');
    const select = rinku.getByLabelText('Role for Rinku') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.title).toBe('You need "Manage roles" (role.manage) in RD to do this');
    const remove = rinku.getByRole('button', { name: 'Remove from RD' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe('You need "Revoke members" (member.revoke) in RD to do this');
    // Each reason is said once, visibly, above the table, and linked from its controls.
    const manage = screen.getByText('You need "Manage roles" (role.manage) in RD to do this');
    const revoke = screen.getByText('You need "Revoke members" (member.revoke) in RD to do this');
    expect(select.getAttribute('aria-describedby')).toBe(manage.id);
    expect(remove.getAttribute('aria-describedby')).toBe(revoke.id);
    expect(manage.compareDocumentPosition(screen.getByRole('table')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('with the keys there is no reason line', async () => {
    at('/team?scope=SH');
    await rowOf('Rinku');
    expect(screen.queryByText(/^You need /)).toBeNull();
  });

  it('the answer to a change sent under another scope is ignored', async () => {
    let refuse!: (e: Error) => void;
    at('/team?scope=SH', () => api.teamSetMember.mockImplementationOnce(() => new Promise((_, no) => { refuse = no; })));
    fireEvent.change((await rowOf('Rinku')).getByLabelText('Role for Rinku'), { target: { value: 'Reader' } });
    await waitFor(() => expect(api.teamSetMember).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Team settings for'), { target: { value: 'RD' } });
    await waitFor(() => expect(api.teamProject).toHaveBeenCalledWith('P_RD'));
    await rowOf('Rinku');
    refuse(refusal(403, 'You need "Edit project" (project.edit) in SH to do this'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.teamProject).toHaveBeenCalledTimes(2);
  });

  it('a success sent under another scope does not reload the new scope', async () => {
    let accept!: (v: unknown) => void;
    at('/team?scope=SH', () => api.teamSetMember.mockImplementationOnce(() => new Promise((yes) => { accept = yes; })));
    fireEvent.change((await rowOf('Rinku')).getByLabelText('Role for Rinku'), { target: { value: 'Reader' } });
    await waitFor(() => expect(api.teamSetMember).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Team settings for'), { target: { value: 'RD' } });
    await waitFor(() => expect(api.teamProject).toHaveBeenCalledWith('P_RD'));
    await rowOf('Rinku');
    accept({ ok: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.teamProject).toHaveBeenCalledTimes(2);
    expect(api.teamOverview).toHaveBeenCalledTimes(2);
  });

  it('the scope picker never overflows the page', async () => {
    at('/team');
    const picker = await screen.findByLabelText('Team settings for');
    expect(picker.className).toContain('max-w-full');
  });

  it('the remove panel gives focus back to the button on Cancel, and to the table after a removal', async () => {
    at('/team?scope=SH');
    const remove = (await rowOf('Rinku')).getByRole('button', { name: 'Remove from SH' });
    fireEvent.click(remove);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(remove);
    fireEvent.click(remove);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.teamRemoveMember).toHaveBeenCalled());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('table')));
  });

  it('the role select lists roles in the Roles tab order: built-ins in catalog order, then custom by name', async () => {
    at('/team', () => api.teamProject.mockResolvedValue({
      ...projectRoster(),
      roles: [
        role('r-reader', 'Reader', ['note.view']),
        { ...role('r-zed', 'Zed', ['note.view']), is_starter: false },
        role('r-owner', 'Owner', ALL_PROJECT, 'all'),
        { ...role('r-aud', 'Auditor', ['note.view']), is_starter: false },
        role('r-contrib', 'Contributor', ['note.view']),
      ],
    }));
    const select = (await rowOf('Rinku')).getByLabelText('Role for Rinku') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Owner', 'Contributor', 'Reader', 'Auditor', 'Zed']);
  });

  it('office scope: office members, office role select, no remove, and the revoke note', async () => {
    at('/team?scope=office');
    await waitFor(() => expect(api.teamOffice).toHaveBeenCalled());
    const rinku = await rowOf('Rinku');
    const select = rinku.getByLabelText('Office role for Rinku') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(rinku.queryByRole('button', { name: /Remove/ })).toBeNull();
    screen.getByText(/To remove a device from the office, use/);
    screen.getByText('collab team revoke');
    fireEvent.change(select, { target: { value: 'Office admin' } });
    await waitFor(() => expect(api.teamSetMember).toHaveBeenCalledWith({ scope: 'office', device: 'dev-r', role: 'Office admin' }));
  });

  it('office scope without office.role.manage: the select is disabled with the office sentence', async () => {
    at('/team?scope=office', () => api.teamOverview.mockResolvedValue({ ...overview(), office: { role: 'Office member', keys: ['office.project.create'] } }));
    const select = (await rowOf('Rinku')).getByLabelText('Office role for Rinku') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.title).toBe('You need "Manage office roles" (office.role.manage) in this office to do this');
    const line = screen.getByText('You need "Manage office roles" (office.role.manage) in this office to do this');
    expect(select.getAttribute('aria-describedby')).toBe(line.id);
  });

  it('a project with only the viewer shows the empty state with the CLI command', async () => {
    at('/team?scope=SH', () => api.teamProject.mockResolvedValue({ ...projectRoster(), members: [projectRoster().members[0]] }));
    await screen.findByText(/This project has no other members yet/);
    screen.getByText('collab team set <member> SH <role>');
  });

  it('not connected: a plain message, and no office calls', async () => {
    at('/team', () => api.teamOverview.mockResolvedValue({ connected: false }));
    await screen.findByText("This notebook isn't connected to a post office. Team settings appear here once it is.");
    expect(api.teamProject).not.toHaveBeenCalled();
  });

  it('a 503 replaces the page body with the message', async () => {
    at('/team?scope=SH', () => api.teamProject.mockRejectedValue(refusal(503, "The post office can't be reached right now.")));
    await screen.findByText("The post office can't be reached right now.");
    expect(screen.queryByRole('table')).toBeNull();
  });
});
