// file: core/test/projects.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate, migrateTo } from '../src/db.js';
import {
  createProject, renameProject, listProjects, findProject, ProjectClashError, ProjectNotFoundError,
} from '../src/projects.js';

function at0009<T>(fn: (db: any) => T): T {
  const t = freshDb();
  try { migrate(t.db); return fn(t.db); } finally { t.cleanup(); }
}

test('create supporthub/sh: code stored SH, mode solo, a valid ulid', () => {
  at0009((db) => {
    const p = createProject(db, { name: 'supporthub', code: 'sh' });
    assert.equal(p.code, 'SH');
    assert.equal(p.name, 'supporthub');
    assert.equal(p.mode, 'solo');
    assert.equal(p.team, null);
    assert.match(p.ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.ok(p.created_at);
  });
});

test('a name or code clash stops with both fixes (P10)', () => {
  at0009((db) => {
    createProject(db, { name: 'supporthub', code: 'SH' });
    assert.throws(() => createProject(db, { name: 'SupportHub', code: 'XY' }), (e: Error) =>
      e instanceof ProjectClashError && /name/.test(e.message) && /rename/.test(e.message) && /different notebook/.test(e.message));
    assert.throws(() => createProject(db, { name: 'other', code: 'sh' }), (e: Error) =>
      e instanceof ProjectClashError && /code/.test(e.message) && /rename/.test(e.message) && /different notebook/.test(e.message));
    assert.equal(listProjects(db).length, 1);
  });
});

test('bad codes are rejected with a message naming the rule', () => {
  at0009((db) => {
    for (const code of ['E', 'S', '1AB', 'ABCDEFGHI', 'S-H', '']) {
      assert.throws(() => createProject(db, { name: `p${code}`, code }), /2-8 letters or digits, starting with a letter/, code);
    }
    assert.throws(() => createProject(db, { name: 'e-ish', code: 'e' }), /not E/);
  });
});

test('createProject refuses team mode and points at the team commands (stage C)', () => {
  at0009((db) => {
    assert.throws(() => createProject(db, { name: 'x', code: 'XX', mode: 'team' } as any), /--team/);
  });
});

test('rename keeps ulid and code, clash-checks the new name', () => {
  at0009((db) => {
    const a = createProject(db, { name: 'alpha', code: 'AL' });
    createProject(db, { name: 'beta', code: 'BE' });
    const r = renameProject(db, 'al', 'Alpha Two');
    assert.equal(r.ulid, a.ulid);
    assert.equal(r.code, 'AL');
    assert.equal(r.name, 'Alpha Two');
    assert.throws(() => renameProject(db, 'AL', 'BETA'), ProjectClashError);
    assert.equal(renameProject(db, a.ulid, 'alpha two').name, 'alpha two', 'renaming to itself in another case is fine');
    assert.throws(() => renameProject(db, 'ZZ', 'x'), ProjectNotFoundError);
  });
});

test('list by name; find by code (any case) or ulid', () => {
  at0009((db) => {
    const z = createProject(db, { name: 'zulu', code: 'ZU' });
    createProject(db, { name: 'alpha', code: 'AL' });
    assert.deepEqual(listProjects(db).map((p) => p.name), ['alpha', 'zulu']);
    assert.equal(findProject(db, 'zu')!.ulid, z.ulid);
    assert.equal(findProject(db, z.ulid)!.code, 'ZU');
    assert.equal(findProject(db, 'NOPE'), null);
  });
});

test('a pre-0009 notebook: every function says it needs migration 0009', () => {
  const t = freshDb();
  try {
    migrateTo(t.db, '0008');
    assert.throws(() => createProject(t.db as any, { name: 'a', code: 'AB' }), /needs migration 0009/);
    assert.throws(() => renameProject(t.db as any, 'AB', 'b'), /needs migration 0009/);
    assert.throws(() => listProjects(t.db as any), /needs migration 0009/);
    assert.throws(() => findProject(t.db as any, 'AB'), /needs migration 0009/);
  } finally { t.cleanup(); }
});
