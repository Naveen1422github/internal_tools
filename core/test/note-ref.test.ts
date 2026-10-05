// file: core/test/note-ref.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { parseNoteRef, parseEntryRef, SERIES_CODE_RE, type NoteRef } from '../src/ulid.js';
import { formatNoteRef } from '../src/entry-ref.js';
import { freshDb } from './helpers/sync.js';
import { migrate } from '../src/db.js';

const ok: Array<[string, NoteRef]> = [
  ['760', { series: 'E', id: 760 }], ['#760', { series: 'E', id: 760 }], ['E760', { series: 'E', id: 760 }],
  ['E-760', { series: 'E', id: 760 }], ['e-00760', { series: 'E', id: 760 }], [' \tE-7 ', { series: 'E', id: 7 }],
  ['SH-12', { series: 'SH', id: 12 }], ['sh-0012', { series: 'SH', id: 12 }], ['AB12CD34-1', { series: 'AB12CD34', id: 1 }],
  ['E2-5', { series: 'E2', id: 5 }],   // a code starting with E is a code, not legacy E
  [' sh-0012 ', { series: 'SH', id: 12 }],
];
const bad = ['', 'E-', 'SH12', 'S-1', '1SH-2', 'SH-0', 'ABCDEFGHI-1', 'SH-1x', 'SH--1', '0', '-1', 'E-SH-1'];

test('parseNoteRef reads every accepted form', () => {
  for (const [v, want] of ok) assert.deepEqual(parseNoteRef(v), want, JSON.stringify(v));
});

test('parseNoteRef rejects everything else', () => {
  for (const v of bad) assert.equal(parseNoteRef(v), null, JSON.stringify(v));
});

test('round trip parseNoteRef(formatNoteRef(r))', () => {
  for (const [, r] of ok) assert.deepEqual(parseNoteRef(formatNoteRef(r)), r);
  assert.equal(formatNoteRef({ series: 'SH', id: 12 }), 'SH-12');
  assert.equal(formatNoteRef({ series: 'E', id: 760 }), 'E-00760');
});

test('SERIES_CODE_RE: 2-8 chars, starts with a letter', () => {
  for (const c of ['SH', 'NV', 'AB12CD34', 'E2']) assert.ok(SERIES_CODE_RE.test(c), c);
  for (const c of ['S', '1AB', 'ABCDEFGHI', 'sh', 'S-H']) assert.ok(!SERIES_CODE_RE.test(c), c);
});

test('parseEntryRef is unchanged for old inputs and rejects series refs', () => {
  for (const v of ['214', '#214', 'E-214', 'e214', 'E-00214', ' 214 ']) assert.equal(parseEntryRef(v), 214);
  for (const v of ['', 'abc', '0', '12abc']) assert.equal(parseEntryRef(v), null);
  assert.equal(parseEntryRef('SH-12'), null);
});

test('parity: the SQL ref trigger resolves exactly what parseNoteRef accepts', () => {
  const t = freshDb();
  try {
    migrate(t.db);
    const ins = t.db.prepare(`INSERT INTO entries (ulid, id, series, type, kind, title, summary, module, category)
                              VALUES (?, ?, ?, 'decision', 'signal', ?, 's', 'm', 'Reference')`);
    const notes: Array<[string, string, number]> = [
      ['01B00000000000000000000760', 'E', 760], ['01B00000000000000000000007', 'E', 7],
      ['01A00000000000000000000012', 'SH', 12], ['01A00000000000000000000001', 'AB12CD34', 1],
      ['01A00000000000000000000005', 'E2', 5],
    ];
    for (const [u, s, i] of notes) ins.run(u, i, s, `${s}-${i}`);
    ins.run('01C00000000000000000000000', 1, 'E', 'source');
    const ulidOf = (r: NoteRef) => notes.find(([, s, i]) => s === r.series && i === r.id)?.[0] ?? null;
    for (const v of [...ok.map(([v]) => v), ...bad]) {
      t.db.prepare(`INSERT INTO refs (entry_ulid, ref_type, ref_value) VALUES ('01C00000000000000000000000', 'entry', ?)`).run(v);
      const got = (t.db.prepare(`SELECT target_ulid t FROM refs WHERE entry_ulid = '01C00000000000000000000000' AND ref_value = ?`).get(v) as { t: string | null }).t;
      const parsed = parseNoteRef(v);
      assert.equal(got, parsed ? ulidOf(parsed) : null, JSON.stringify(v));
    }
  } finally { t.cleanup(); }
});
