// file: courier/test/role-edit-access.test.ts
// RnR R15 through a role edit (S3-5): since roles can be re-keyed, a member can
// lose note.view while staying a member. The office then still lists the
// project in /v1/access, with keys lacking note.view, and sends it nothing; the
// laptop must treat it like a removal (read-only), and like a return when
// note.view comes back. N owns SH; R's laptop holds Reader. One office.
import { test } from 'node:test';
import assert from 'node:assert';
import type { Database as DB } from 'better-sqlite3';
import { addEntryAsync, newUlid, requestJson, findProject, getEntryByUlid, readAccessCache } from '@collab-mcp/core';
import { registerProject, setProjectMember } from '@collab-mcp/post-office';
import { tempDir, startOffice, joinedDb, openWriter, closeWriter } from './world.js';
import { Courier } from '../src/engine.js';

async function world() {
  const t = tempDir('collab-role-edit-');
  const office = await startOffice(t.dir, 0);
  const jn = await joinedDb(office, t.dir, 'n'), jr = await joinedDb(office, t.dir, 'r');
  const wn = openWriter(jn.path), wr = openWriter(jr.path);
  const cn = new Courier({ dbPath: jn.path, watch: false, retryMs: 60_000 });
  const cr = new Courier({ dbPath: jr.path, watch: false, retryMs: 60_000 });
  return {
    office, wn, wr, cn, cr, n: jn.device, r: jr.device,
    cleanup: async () => {
      await cn.stop(); await cr.stop();
      closeWriter(wn); closeWriter(wr);
      await office.close();
      t.cleanup();
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'decision' as const, title, summary: `${title} summary`, ...extra });
const titlesIn = (db: DB, code: string) =>
  (db.prepare(`SELECT title FROM entries WHERE series = ? AND deleted_at IS NULL ORDER BY id`).all(code) as Array<{ title: string }>).map((r) => r.title);
async function write(w: World, code: string, ...titles: string[]) {
  const out = [];
  for (const t of titles) out.push((await addEntryAsync(w.wn, note(t, { project: code }))).ulid);
  await w.cn.pushNow();
  return out;
}
/** N (Owner) re-keys SH's Reader role over HTTP, as the admin UI does. */
async function setReaderKeys(w: World, p: string, keys: string[]) {
  const reader = w.office.store.prepare(`SELECT ulid FROM po_roles WHERE project_ulid = ? AND name = 'Reader'`).get(p) as { ulid: string };
  const res = await requestJson(w.cn.target, 'PUT' as 'POST', `/v1/projects/${p}/roles/${reader.ulid}`, { keys });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

test('a role edit that takes note.view away makes the project read-only; giving it back makes it writable', async () => {
  const w = await world();
  try {
    const sh = registerProject(w.office.store, { ulid: newUlid(), name: 'Support hub', code: 'SH', seed: 0 }, w.n);
    await w.cn.syncNow();
    await write(w, 'SH', 'one', 'two');
    setProjectMember(w.office.store, w.n, sh.ulid, w.r, 'Reader');
    await w.cr.syncNow();
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['one', 'two']);
    assert.equal(findProject(w.wr, 'SH')!.left_at, null);
    const readerKeys = [...readAccessCache(w.wr).get(sh.ulid)!.keys];
    assert.ok(readerKeys.includes('note.view'));

    // N takes note.view off Reader; R stays a member, the office still lists SH for it
    await setReaderKeys(w, sh.ulid, readerKeys.filter((k) => k !== 'note.view'));
    await w.cr.syncNow();
    assert.equal(readAccessCache(w.wr).get(sh.ulid)?.role, 'Reader', 'still a member at the office');
    assert.equal(readAccessCache(w.wr).get(sh.ulid)!.keys.has('note.view'), false);
    assert.ok(findProject(w.wr, 'SH')!.left_at, 'no note.view: read-only, like a removal');
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['one', 'two'], 'R keeps the notes');
    await assert.rejects(addEntryAsync(w.wr, note('R writes', { project: 'SH' })), /SH \(Support hub\) is a team you left: its notes are read-only/, 'writes refused as for a removed member');
    await write(w, 'SH', 'while R cannot view');
    await w.cr.syncNow();
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['one', 'two'], 'nothing new arrives');
    assert.ok(findProject(w.wr, 'SH')!.left_at, 'stays read-only on the next refresh');

    // N gives note.view back: writable again, and what was missed arrives (R14)
    await setReaderKeys(w, sh.ulid, readerKeys);
    await w.cr.syncNow();
    assert.equal(findProject(w.wr, 'SH')!.left_at, null, 'writable again');
    assert.deepEqual(titlesIn(w.wr, 'SH'), ['one', 'two', 'while R cannot view']);
    // no longer refused as read-only: a Reader is refused only for lacking note.create
    await assert.rejects(addEntryAsync(w.wr, note('R writes', { project: 'SH' })), /You need "Create notes" \(note\.create\) in SH/);
    // and once its role may create, R writes and N receives it
    await setReaderKeys(w, sh.ulid, [...readerKeys, 'note.create']);
    await w.cr.syncNow();
    const mine = await addEntryAsync(w.wr, note('R writes again', { project: 'SH' }));
    await w.cr.pushNow();
    await w.cn.syncNow();
    assert.equal(getEntryByUlid(w.wn, mine.ulid)?.title, 'R writes again', 'R sends again');
  } finally { await w.cleanup(); }
});
