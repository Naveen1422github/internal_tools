// UI parity Task 9: the New note form says where a note will land, by addEntryAsync's own rule.
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';
import { createProject, markProjectLeft } from '../src/projects.js';
import { bindModule } from '../src/ops/bind.js';
import { initModule } from '../src/ops/module.js';
import { noteDestination } from '../src/ops/add.js';

test('named, bound, none; an unknown or left project throws what the save would', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    createProject(t.db, { name: 'Navi', code: 'NV' });
    initModule(t.db, { slug: 'billing' });
    bindModule(t.db, 'billing', 'NV');
    assert.deepEqual(noteDestination(t.db, { project: 'NV' }), {
      project: { code: 'NV', name: 'Navi', mode: 'solo' }, why: 'named', line: 'It goes into NV (Navi). It stays on this laptop.',
    });
    const bound = noteDestination(t.db, { module: 'billing' });
    assert.equal(bound.why, 'bound');
    assert.equal(bound.line, 'It goes into NV (Navi) because module billing is bound to NV. It stays on this laptop.');
    const none = noteDestination(t.db, { module: 'other', project: 'none' });
    assert.deepEqual([none.project, none.why], [null, 'none']);
    assert.throws(() => noteDestination(t.db, { project: 'ZZ' }), /no project "ZZ"/);
    t.db.prepare(`INSERT INTO projects (ulid, name, code, mode, team) VALUES ('01JPR0JECTTM00000000000000', 'Team', 'TM', 'team', 'fp')`).run();
    assert.match(noteDestination(t.db, { project: 'TM' }).line, /shared with the project's members; the post office numbers it/);
    markProjectLeft(t.db, 'TM');
    assert.throws(() => noteDestination(t.db, { project: 'TM' }), /a team you left/);
  } finally { t.cleanup(); }
});
