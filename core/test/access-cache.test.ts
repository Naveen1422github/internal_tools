// file: core/test/access-cache.test.ts
// RnR S1: local (never synced) cache of this laptop's permissions (0012).
import { test } from 'node:test';
import assert from 'node:assert';
import { freshDb } from './helpers/sync.js';
import { migrate, latestMigration } from '../src/db.js';
import { SYNCED_TABLES } from '../src/sync/enable.js';
import { writeAccessCache, readAccessCache } from '../src/access/cache.js';

const A = '01JPR0JECTAAAAAAAAAAAAAAAA';
const B = '01JPR0JECTBBBBBBBBBBBBBBBB';

test('0012 is local and latest', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    assert.equal(latestMigration(t.db), '0012_access_cache');
    assert.ok(!SYNCED_TABLES.includes('access_cache' as never));
  } finally { t.cleanup(); }
});

test('writeAccessCache replaces rows and reports dropped projects', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    writeAccessCache(t.db, { office: { role: 'Office member', keys: ['office.project.create'] },
      projects: [{ ulid: A, code: 'SH', role: 'Owner', keys: ['note.view', 'bogus'], ai: {} },
                 { ulid: B, code: 'NV', role: 'Reader', keys: ['note.view'], ai: {} }], replays: [] });
    assert.deepEqual([...readAccessCache(t.db).get(A)!.keys], ['note.view']);
    assert.deepEqual([...readAccessCache(t.db).get('office')!.keys], ['office.project.create']);
    const r = writeAccessCache(t.db, { office: null, projects: [{ ulid: A, code: 'SH', role: 'Owner', keys: ['note.view'], ai: {} }], replays: [] });
    assert.deepEqual(r.dropped, [B]);
    assert.equal(readAccessCache(t.db).has('office'), false);
    assert.equal(readAccessCache(t.db).has(B), false);
  } finally { t.cleanup(); }
});
