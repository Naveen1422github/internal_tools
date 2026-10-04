// file: core/test/sync-disable.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { freshDb } from './helpers/sync.js';
import { addEntry, addEntryAsync } from '../src/ops/add.js';
import { doctor } from '../src/ops/doctor.js';
import { setAllocator } from '../src/sync/allocator.js';
import { setSyncValue, isSyncEnabled } from '../src/sync/state.js';
import { disableSync } from '../src/sync/enable.js';
import { hasCrrTables, isCrsqliteLoaded } from '../src/sync/extension.js';

test('disableSync undoes enableSync; the DB then opens and writes without cr-sqlite', async () => {
  const { db, path, cleanup } = freshDb({ shared: true });
  try {
    setSyncValue(db, 'device_key', 'secret');
    setSyncValue(db, 'po_url', 'https://10.0.0.1:7443');
    setAllocator({ allocate: async () => 50 });
    await addEntryAsync(db, { type: 'decision', title: 'kept', summary: 's', module: 'm' });
    assert.deepEqual(disableSync(db), { wasEnabled: true });
    assert.equal(hasCrrTables(db), false);
    assert.equal(isSyncEnabled(db), false);
    assert.deepEqual(db.prepare('SELECT key, value FROM sync_state').all(), [{ key: 'enabled', value: '0' }]);
    db.prepare('SELECT crsql_finalize()').get();
    db.close();
    const plain = new Database(path); // no extension loaded
    try {
      assert.equal(isCrsqliteLoaded(plain), false);
      assert.equal(addEntry(plain, { type: 'decision', title: 'after', summary: 's', module: 'm' }).id, 51);
      plain.prepare(`UPDATE entries SET updated_at = '2000-01-01 00:00:00' WHERE id = 50`).run();
      plain.prepare(`UPDATE entries SET status = 'resolved' WHERE id = 50`).run();
      const r = plain.prepare(`SELECT title, updated_at FROM entries WHERE id = 50`).get() as { title: string; updated_at: string };
      assert.equal(r.title, 'kept');
      assert.notEqual(r.updated_at, '2000-01-01 00:00:00', 'the restored 0006 trigger runs');
      const checks = doctor(plain).checks;
      for (const name of ['schema.tables', 'schema.indexes', 'schema.triggers']) {
        assert.equal(checks.find((c) => c.name === name)!.severity, 'ok', name);
      }
      assert.equal(checks.find((c) => c.name === 'sync.extension'), undefined);
    } finally { plain.close(); }
  } finally { setAllocator(null); cleanup(); }
});

test('disableSync on a DB that never shared is a no-op', () => {
  const { db, cleanup } = freshDb();
  try {
    assert.deepEqual(disableSync(db), { wasEnabled: false });
    assert.equal(isCrsqliteLoaded(db), false);
  } finally { cleanup(); }
});
