// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// RnR S3 (Task 7): the Roles tab and the role editor. Built-ins first, inactive
// keys never shown or sent, locked built-ins read-only, and the office's refusal
// shown word for word.
const ALL_PROJECT = ['note.view', 'note.create', 'note.edit.own', 'note.edit.any', 'note.supersede', 'note.archive',
  'note.copy.out', 'merge.resolve', 'project.edit', 'member.invite', 'member.revoke', 'role.manage', 'ai_limits.manage'];
const ALL_OFFICE = ['office.project.create', 'office.module.share', 'office.member.add', 'office.member.revoke',
  'office.role.manage', 'module.create', 'module.edit'];
const TASKS = ['task.create', 'task.assign', 'task.status.change'];
const EDITOR = ['note.view', 'note.create', 'note.edit.own', 'note.edit.any', 'note.supersede', 'note.archive', 'note.copy.out', ...TASKS, 'merge.resolve'];

const overview = () => ({
  connected: true as const,
  me: { device_id: 'dev-me' },
  office: { role: 'Office admin', keys: ALL_OFFICE },
  projects: [
    { ulid: 'P_SH', code: 'SH', name: 'Shop', role: 'Owner', keys: ALL_PROJECT },
    { ulid: 'P_LM', code: 'LM', name: 'Limited', role: 'Manager', keys: ['role.manage', 'note.view'] },
    { ulid: 'P_RD', code: 'RD', name: 'Research', role: 'Reader', keys: ['note.view'] },
  ],
});
const role = (ulid: string, name: string, keys: string[], is_starter = true, locked: 'all' | 'name' | null = null) =>
  ({ ulid, name, keys, is_starter, locked });
const member = (device_id: string, name: string, r: { ulid: string; name: string }) =>
  ({ device_id, name, role: r.name, role_ulid: r.ulid, last_seen_at: null });
// The office answers ORDER BY name; the tab puts built-ins first.
const projectRoster = () => {
  const owner = role('r-owner', 'Owner', [...ALL_PROJECT, ...TASKS], true, 'all');
  const editor = role('r-editor', 'Editor', EDITOR);
  const contrib = role('r-contrib', 'Contributor', ['note.view', 'note.create', 'note.edit.own', 'task.status.change']);
  const reader = role('r-reader', 'Reader', ['note.view']);
  const auditors = role('r-aud', 'auditors', ['note.view', 'note.archive'], false);
  const zeta = role('r-zeta', 'Zeta', ['note.view'], false);
  return {
    members: [member('dev-me', 'Naveen', owner), member('dev-r', 'Rinku', contrib), member('dev-s', 'Sita', contrib)],
    roles: [auditors, contrib, editor, owner, reader, zeta],
  };
};
const officeRoster = () => {
  const admin = role('o-admin', 'Office admin', ALL_OFFICE, true, 'all');
  const officeMember = role('o-member', 'Office member', ['office.project.create'], true, 'name');
  return { members: [member('dev-me', 'Naveen', admin)], roles: [officeMember, admin] };
};
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });

const api = vi.hoisted(() => ({
  teamOverview: vi.fn(),
  teamProject: vi.fn(),
  teamOffice: vi.fn(),
  teamSetMember: vi.fn(),
  teamRemoveMember: vi.fn(),
  teamCreateRole: vi.fn(),
  teamUpdateRole: vi.fn(),
  teamDeleteRole: vi.fn(),
  RELOAD_MESSAGE: 'reload',
}));
vi.mock('../api/client', () => api);

import Team from '../pages/Team';

/** Render /team at `path` with default answers (after `setup`), then open the Roles tab. */
async function rolesAt(path: string, setup?: () => void) {
  api.teamOverview.mockResolvedValue(overview());
  api.teamProject.mockResolvedValue(projectRoster());
  api.teamOffice.mockResolvedValue(officeRoster());
  api.teamCreateRole.mockResolvedValue({ role: { ulid: 'r-new', name: 'x', keys: [] } });
  api.teamUpdateRole.mockResolvedValue({ ok: true });
  api.teamDeleteRole.mockResolvedValue({ ok: true });
  setup?.();
  render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/team" element={<Team />} /></Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('tab', { name: 'Roles' }));
  await screen.findAllByRole('article');
}
const cardNames = () => screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));
const card = (name: string) => within(screen.getByRole('article', { name }));
const editor = () => within(screen.getByRole('form', { name: /role/i }));

describe('Roles tab', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('lists built-in roles first in catalog order, then custom roles by name, with tags and member counts', async () => {
    await rolesAt('/team?scope=SH');
    expect(cardNames()).toEqual(['Owner', 'Editor', 'Contributor', 'Reader', 'auditors', 'Zeta']);
    card('Owner').getByText('Built-in');
    card('Owner').getByText('1 member');
    card('Contributor').getByText('2 members');
    card('Reader').getByText('No members');
    expect(card('Zeta').queryByText('Built-in')).toBeNull();
    // Delete only for custom roles; View instead of Edit for Owner.
    expect(card('Editor').queryByRole('button', { name: 'Delete' })).toBeNull();
    card('Zeta').getByRole('button', { name: 'Delete' });
    card('Owner').getByRole('button', { name: 'View' });
    expect(card('Owner').queryByRole('button', { name: 'Edit' })).toBeNull();
    card('Editor').getByRole('button', { name: 'Edit' });
    card('Contributor').getByText('Edit own notes');
    screen.getByRole('button', { name: 'New role' });
  });

  it('inactive task keys never appear, on cards or in the editor', async () => {
    await rolesAt('/team?scope=SH');
    const panel = () => screen.getByRole('tabpanel');
    expect(panel().textContent).not.toMatch(/task\.|Create tasks|Assign tasks|Change task status/);
    fireEvent.click(card('Editor').getByRole('button', { name: 'Edit' }));
    editor().getByRole('checkbox', { name: 'Supersede notes' });
    expect(panel().textContent).not.toMatch(/task\.|Create tasks|Assign tasks|Change task status/);
    expect(editor().queryByText('Tasks')).toBeNull();
    expect(editor().queryByText('project.make_solo')).toBeNull();
  });

  it('the editor shows each key with label, description and key, and the laptop note only on laptop-checked keys', async () => {
    await rolesAt('/team?scope=SH');
    fireEvent.click(screen.getByRole('button', { name: 'New role' }));
    const f = editor();
    const note = 'Checked on this laptop. It limits your AI, but it is not a security boundary.';
    const describe = (label: string) => {
      const box = f.getByRole('checkbox', { name: label });
      return (box.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    };
    expect(describe('Copy notes out')).toContain(note);
    expect(describe('Edit project')).toContain(note);
    expect(describe('View notes')).not.toContain(note);
    expect(describe('View notes')).toContain('Read notes in the project');
    expect(f.getByText('note.view').tagName).toBe('CODE');
    f.getByText('Notes');
    f.getByText('Team & access');
  });

  it('the Owner editor is read-only with the note', async () => {
    await rolesAt('/team?scope=SH');
    fireEvent.click(card('Owner').getByRole('button', { name: 'View' }));
    const f = editor();
    f.getByText("This built-in role always holds every permission. It can't be renamed or changed.");
    expect((f.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
    for (const box of f.getAllByRole('checkbox') as HTMLInputElement[]) {
      expect(box.checked).toBe(true);
      expect(box.disabled).toBe(true);
    }
    expect(f.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(f.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('form', { name: /role/i })).toBeNull();
  });

  it('Duplicate prefills the keys and "<Name> (copy)", and saving creates a role', async () => {
    await rolesAt('/team?scope=SH');
    fireEvent.click(card('Contributor').getByRole('button', { name: 'Duplicate' }));
    const f = editor();
    expect((f.getByLabelText('Name') as HTMLInputElement).value).toBe('Contributor (copy)');
    expect((f.getByRole('checkbox', { name: 'Edit own notes' }) as HTMLInputElement).checked).toBe(true);
    expect((f.getByRole('checkbox', { name: 'Edit any note' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(f.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.teamCreateRole).toHaveBeenCalledWith({
      scope: 'project', project: 'P_SH', name: 'Contributor (copy)', keys: ['note.view', 'note.create', 'note.edit.own'],
    }));
    await waitFor(() => expect(screen.queryByRole('form', { name: /role/i })).toBeNull());
  });

  it('Save sends active keys only, in catalog order, by role ULID', async () => {
    await rolesAt('/team?scope=SH');
    fireEvent.click(card('Editor').getByRole('button', { name: 'Edit' }));
    const f = editor();
    fireEvent.click(f.getByRole('checkbox', { name: 'Archive notes' }));
    fireEvent.click(f.getByRole('checkbox', { name: 'Manage AI limits' }));
    fireEvent.change(f.getByLabelText('Name'), { target: { value: 'Writer' } });
    fireEvent.click(f.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.teamUpdateRole).toHaveBeenCalledWith({
      scope: 'project', project: 'P_SH', role: 'r-editor', name: 'Writer',
      keys: ['note.view', 'note.create', 'note.edit.own', 'note.edit.any', 'note.supersede', 'note.copy.out', 'merge.resolve', 'ai_limits.manage'],
    }));
  });

  it('a toggle for a key the viewer lacks is disabled with the reason', async () => {
    await rolesAt('/team?scope=LM');
    fireEvent.click(screen.getByRole('button', { name: 'New role' }));
    const f = editor();
    const supersede = f.getByRole('checkbox', { name: 'Supersede notes' }) as HTMLInputElement;
    expect(supersede.disabled).toBe(true);
    expect(supersede.closest('label')?.title).toBe('You can only give permissions you hold yourself.');
    expect((f.getByRole('checkbox', { name: 'View notes' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('without role.manage every editing control is disabled with the standard sentence', async () => {
    await rolesAt('/team?scope=RD');
    const sentence = 'You need "Manage roles" (role.manage) in RD to do this';
    const buttons = [
      screen.getByRole('button', { name: 'New role' }),
      card('Editor').getByRole('button', { name: 'Edit' }),
      card('Editor').getByRole('button', { name: 'Duplicate' }),
      card('Zeta').getByRole('button', { name: 'Delete' }),
    ] as HTMLButtonElement[];
    for (const b of buttons) {
      expect(b.disabled).toBe(true);
      expect(b.title).toBe(sentence);
    }
    expect((card('Owner').getByRole('button', { name: 'View' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('delete asks first, then shows the office\'s 409 word for word', async () => {
    const held = 'This role is held by 2 members. Give them another role first.';
    await rolesAt('/team?scope=SH', () => api.teamDeleteRole.mockRejectedValue(refusal(409, held)));
    fireEvent.click(card('Zeta').getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm.textContent).toContain("Delete the role Zeta? This can't be undone.");
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.teamDeleteRole).not.toHaveBeenCalled();

    fireEvent.click(card('Zeta').getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.teamDeleteRole).toHaveBeenCalledWith({ scope: 'project', project: 'P_SH', role: 'r-zeta' }));
    expect((await screen.findByRole('alert')).textContent).toContain(held);
  });

  it('office scope: Office admin is read-only, Office member keeps its name, and updates omit the project', async () => {
    await rolesAt('/team?scope=office');
    expect(cardNames()).toEqual(['Office admin', 'Office member']);
    card('Office admin').getByRole('button', { name: 'View' });
    fireEvent.click(card('Office member').getByRole('button', { name: 'Edit' }));
    const f = editor();
    f.getByText("This built-in role can't be renamed.");
    expect((f.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(f.getByRole('checkbox', { name: 'Create modules' }));
    fireEvent.click(f.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.teamUpdateRole).toHaveBeenCalledWith({
      scope: 'office', role: 'o-member', keys: ['office.project.create', 'module.create'],
    }));
  });
});
