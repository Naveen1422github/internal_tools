// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// RnR S3 (Task 8, S3-8): "Who can do what", roles against permissions, read-only.
const ALL_PROJECT = ['note.view', 'note.create', 'note.edit.own', 'note.edit.any', 'note.supersede', 'note.archive',
  'note.copy.out', 'merge.resolve', 'project.edit', 'member.invite', 'member.revoke', 'role.manage', 'ai_limits.manage'];
const ALL_OFFICE = ['office.project.create', 'office.module.share', 'office.member.add', 'office.member.revoke',
  'office.role.manage', 'module.create', 'module.edit'];
const TASKS = ['task.create', 'task.assign', 'task.status.change'];
const LAPTOP_NOTE = 'Checked on this laptop. It limits your AI, but it is not a security boundary.';

const overview = () => ({
  connected: true as const,
  me: { device_id: 'dev-me' },
  office: { role: 'Office member', keys: ['office.project.create'] },
  projects: [{ ulid: 'P_SH', code: 'SH', name: 'Shop', role: 'Reader', keys: ['note.view'] }],
});
const role = (ulid: string, name: string, keys: string[], is_starter = true, locked: 'all' | 'name' | null = null) =>
  ({ ulid, name, keys, is_starter, locked });
const member = (device_id: string, name: string, r: { ulid: string; name: string }) =>
  ({ device_id, name, role: r.name, role_ulid: r.ulid, last_seen_at: null });
const projectRoster = () => {
  const owner = role('r-owner', 'Owner', [...ALL_PROJECT, ...TASKS], true, 'all');
  const contrib = role('r-contrib', 'Contributor', ['note.view', 'note.create', 'note.edit.own', 'task.status.change']);
  const reader = role('r-reader', 'Reader', ['note.view']);
  const auditors = role('r-aud', 'Auditors', ['note.view', 'note.archive'], false);
  return {
    members: [member('dev-me', 'Naveen', owner), member('dev-r', 'Rinku', contrib), member('dev-s', 'Sita', contrib)],
    roles: [auditors, contrib, owner, reader],
  };
};
const officeRoster = () => {
  const admin = role('o-admin', 'Office admin', ALL_OFFICE, true, 'all');
  const officeMember = role('o-member', 'Office member', ['office.project.create'], true, 'name');
  return { members: [member('dev-me', 'Naveen', officeMember), member('dev-a', 'Asha', admin)], roles: [officeMember, admin] };
};

const api = vi.hoisted(() => ({
  teamOverview: vi.fn(),
  teamProject: vi.fn(),
  teamOffice: vi.fn(),
  RELOAD_MESSAGE: 'reload',
}));
vi.mock('../api/client', () => api);

import Team from '../pages/Team';

async function matrixAt(path: string) {
  api.teamOverview.mockResolvedValue(overview());
  api.teamProject.mockResolvedValue(projectRoster());
  api.teamOffice.mockResolvedValue(officeRoster());
  render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/team" element={<Team />} /></Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('tab', { name: 'Who can do what' }));
  return screen.findByRole('table');
}
/** Column headers' role names, in order. */
const columns = (table: HTMLElement) =>
  within(table).getAllByRole('columnheader').slice(1).map((th) => th.querySelector('[data-role-name]')?.textContent);
/** The cell for a key's row under a role's column: "Allowed" or "Not allowed". */
function cell(table: HTMLElement, key: string, roleName: string): string {
  const col = columns(table).indexOf(roleName);
  expect(col).toBeGreaterThanOrEqual(0);
  const row = within(table).getByText(key, { selector: 'code' }).closest('tr')!;
  // The check mark is aria-hidden; what a screen reader hears is the sr-only text.
  return (row.querySelectorAll('td')[col].textContent ?? '').replace('✓', '');
}

describe('Who can do what', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('columns are roles in the Roles tab order, with the caption', async () => {
    const table = await matrixAt('/team?scope=SH');
    expect(columns(table)).toEqual(['Owner', 'Contributor', 'Reader', 'Auditors']);
    screen.getByText('Each column is a role; the names under it are the members who hold it.');
  });

  it("Contributor's column allows note.edit.own and not note.supersede", async () => {
    const table = await matrixAt('/team?scope=SH');
    expect(cell(table, 'note.edit.own', 'Contributor')).toBe('Allowed');
    expect(cell(table, 'note.supersede', 'Contributor')).toBe('Not allowed');
    expect(cell(table, 'note.supersede', 'Owner')).toBe('Allowed');
    expect(cell(table, 'note.archive', 'Auditors')).toBe('Allowed');
  });

  it("members' names appear under their role, or \"No members\"", async () => {
    const table = await matrixAt('/team?scope=SH');
    const header = (name: string) => within(table).getAllByRole('columnheader').find((th) => th.querySelector('[data-role-name]')?.textContent === name)!;
    expect(header('Contributor').textContent).toContain('Rinku');
    expect(header('Contributor').textContent).toContain('Sita');
    expect(header('Owner').textContent).toContain('Naveen');
    expect(header('Owner').textContent).not.toContain('Rinku');
    expect(header('Reader').textContent).toContain('No members');
  });

  it('a role held only by removed devices shows the office\'s count, not "No members"', async () => {
    api.teamOverview.mockResolvedValue(overview());
    api.teamProject.mockResolvedValue({
      ...projectRoster(),
      roles: projectRoster().roles.map((r) => (r.name === 'Auditors' ? { ...r, holders: 2 } : r)),
    });
    render(<MemoryRouter initialEntries={['/team?scope=SH']}><Routes><Route path="/team" element={<Team />} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Who can do what' }));
    const table = await screen.findByRole('table');
    const header = within(table).getAllByRole('columnheader').find((th) => th.querySelector('[data-role-name]')?.textContent === 'Auditors')!;
    expect(header.textContent).toContain('2 members');
    expect(header.textContent).not.toContain('No members');
  });

  it('no inactive key row; rows grouped by area; laptop-checked rows carry the note', async () => {
    const table = await matrixAt('/team?scope=SH');
    expect(table.textContent).not.toMatch(/task\.|Create tasks|project\.make_solo|project\.delete/);
    within(table).getByRole('rowheader', { name: 'Notes' });
    within(table).getByRole('rowheader', { name: 'Team & access' });
    expect(within(table).queryByRole('rowheader', { name: 'Tasks' })).toBeNull();
    const rowOf = (key: string) => within(table).getByText(key, { selector: 'code' }).closest('tr')!;
    expect(rowOf('note.copy.out').textContent).toContain(LAPTOP_NOTE);
    expect(rowOf('project.edit').textContent).not.toContain(LAPTOP_NOTE); // checked at the office since UI parity D1
    expect(rowOf('note.view').textContent).not.toContain(LAPTOP_NOTE);
    // Read-only: nothing to press or tick.
    expect(within(table).queryAllByRole('button')).toEqual([]);
    expect(within(table).queryAllByRole('checkbox')).toEqual([]);
  });

  it('office scope shows office keys and office roles', async () => {
    const table = await matrixAt('/team?scope=office');
    expect(columns(table)).toEqual(['Office admin', 'Office member']);
    expect(cell(table, 'office.role.manage', 'Office admin')).toBe('Allowed');
    expect(cell(table, 'office.role.manage', 'Office member')).toBe('Not allowed');
    expect(cell(table, 'office.project.create', 'Office member')).toBe('Allowed');
    expect(table.textContent).not.toContain('note.view');
  });

  it('scrolls sideways inside its own box', async () => {
    const table = await matrixAt('/team?scope=SH');
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });
});
