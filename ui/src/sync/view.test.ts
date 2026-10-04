// file: ui/src/sync/view.test.ts
import { describe, it, expect } from 'vitest';
import { barView, ago, fieldDiff, versionLabel, shareLabel, saveNote } from './view';

const now = new Date('2026-10-04T10:10:00Z');
const base = {
  enabled: true as const, postOffice: 'https://x:7443', deviceId: 'd', sharedModules: ['portfolio'], unsent: 0,
  courier: { running: true, state: 'connected', lastError: null, lastPushAt: '2026-10-04T10:09:48Z', lastPullAt: null },
  lastContactAt: '2026-10-04T10:09:48Z', health: 'ok' as const,
};

describe('barView', () => {
  it('sharing off: no bar', () => expect(barView({ enabled: false }, now)).toBeNull());
  it('ok', () => expect(barView(base, now)).toEqual({ tone: 'ok', text: '● Sharing on · last contact 12 s ago · nothing waiting to send', fix: null }));
  it('behind with waiting changes', () =>
    expect(barView({ ...base, health: 'behind', unsent: 3, lastContactAt: '2026-10-04T10:06:00Z', courier: { ...base.courier, state: 'offline' } }, now))
      .toEqual({ tone: 'warn', text: '● Behind · last contact 4 min ago · 3 changes waiting to send · the courier is retrying', fix: null }));
  it('one change uses the singular', () =>
    expect(barView({ ...base, health: 'behind', unsent: 1 }, now)!.text).toContain('1 change waiting to send'));
  it('not syncing', () =>
    expect(barView({ ...base, health: 'not-syncing', unsent: 12 }, now))
      .toEqual({ tone: 'bad', text: '● Not syncing · the courier is not running · 12 changes waiting', fix: 'how to fix: run collab sync start' }));
  it('needs update', () =>
    expect(barView({ ...base, health: 'needs-update', courier: { ...base.courier, state: 'needs-update', lastError: 'update this laptop: the post office is on 0009_x, this notes DB is on 0008_revision_author' } }, now))
      .toEqual({ tone: 'bad', text: '● Not syncing · update this laptop: the post office is on 0009_x, this notes DB is on 0008_revision_author', fix: 'how to fix: git pull, npm run build, npm run migrate, then restart collab' }));
  it('revoked', () =>
    expect(barView({ ...base, health: 'revoked' }, now)!.text).toBe('● Not syncing · this laptop was removed from the team · ask the post office owner for a new join code'));
  it('unknown never looks healthy', () =>
    expect(barView({ ...base, health: 'unknown' }, now)).toEqual({ tone: 'bad', text: '● Sync status unknown', fix: 'how to fix: run collab sync status in a terminal' }));
});

describe('ago', () => {
  it('seconds, minutes, hours, never', () => {
    expect(ago('2026-10-04T10:09:48Z', now)).toBe('12 s ago');
    expect(ago('2026-10-04T10:06:00Z', now)).toBe('4 min ago');
    expect(ago('2026-10-04T07:10:00Z', now)).toBe('3 h ago');
    expect(ago(null, now)).toBe('never');
  });
});

describe('merge view', () => {
  const v = (o: Partial<any>) => ({ rev_id: 'r', title: 'T', summary: 'S', description: 'D', author: 'naveen', created_at: '2026-10-04 15:35:22.949', ...o });
  it('fieldDiff marks only the fields that differ', () => {
    expect(fieldDiff([v({ summary: 'Edited on NAVEEN' }), v({ summary: 'Edited on RINKU' })])).toEqual({ title: false, summary: true, description: false });
    expect(fieldDiff([v({}), v({ description: null })]).description).toBe(true);
  });
  it('versionLabel shows number, author and time; unknown author says so', () => {
    expect(versionLabel(v({}), 0)).toBe('Version 1 · naveen · 15:35');
    expect(versionLabel(v({ author: null }), 1)).toBe('Version 2 · unknown author · 15:35');
  });
});

describe('sharing labels', () => {
  const on = { ...base, sharedModules: ['portfolio'] };
  it('labels only when sharing is on', () => {
    expect(shareLabel('portfolio', on)).toBe('shared');
    expect(shareLabel('custom-reports', on)).toBe('private');
    expect(shareLabel('portfolio', { enabled: false })).toBeNull();
    expect(shareLabel('portfolio', null)).toBeNull();
    expect(shareLabel(null, on)).toBe('private');
  });
  it('save note only for a shared module', () => {
    expect(saveNote('portfolio', on)).toBe('⇄ portfolio is shared: when you save, this note goes to everyone on the team.');
    expect(saveNote('custom-reports', on)).toBeNull();
    expect(saveNote('portfolio', { enabled: false })).toBeNull();
  });
});
