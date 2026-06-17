import { test, after } from 'node:test';
import { matchSnapshot, stable } from './snapshot.js';
import { freshDb } from './seed.js';
import {
  searchEntries, type SearchArgs,
  getEntry, listRecent, getModule, doctor,
} from '@collab-mcp/core';

const h = freshDb();
after(() => h.close());

// searchEntries requires the full SearchArgs shape; this is the "match everything" base.
const ALL: SearchArgs = { query: '', kind: 'any', include_deprecated: false, limit: 50 };

test('golden: searchEntries all', () => {
  matchSnapshot('mcp_search_all', stable(searchEntries(h.db, ALL)));
});
test('golden: searchEntries module demo', () => {
  matchSnapshot('mcp_search_module_demo', stable(searchEntries(h.db, { ...ALL, module: 'demo' })));
});
test('golden: searchEntries category Reference', () => {
  matchSnapshot('mcp_search_category_reference', stable(searchEntries(h.db, { ...ALL, category: 'Reference' })));
});
test('golden: listRecent', () => {
  matchSnapshot('mcp_list_recent', stable(listRecent(h.db, { kind: 'any' })));
});
test('golden: getEntry first row', () => {
  const first = searchEntries(h.db, ALL).results[0]?.id ?? 1;
  matchSnapshot('mcp_get_entry', stable(getEntry(h.db, first)));
});
test('golden: getModule demo', () => {
  matchSnapshot('mcp_module_demo', stable(getModule(h.db, 'demo')));
});
test('golden: doctor', () => {
  matchSnapshot('mcp_doctor', stable(doctor(h.db)));
});
