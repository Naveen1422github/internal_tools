import { test, before, after } from 'node:test';
import { startTestServer, seedEntry } from '../helpers/server.mjs';
import { matchSnapshot } from './snapshot.mjs';

let srv;

// Replace volatile fields so snapshots are stable across runs/machines.
function stable(obj) {
  return JSON.parse(JSON.stringify(obj, (k, v) => {
    if (k === 'id' || k === 'entry_id') return '<id>';
    if (k === 'created_at' || k === 'updated_at') return '<ts>';
    if (k === 'tokens_estimate') return '<tok>';
    return v;
  }));
}

before(async () => {
  srv = await startTestServer();
  seedEntry(srv.db, { type: 'decision', category: 'Reference', title: 'Alpha decision', module: 'demo' });
  seedEntry(srv.db, { type: 'changelog', category: 'Activity', title: 'Beta change', module: 'demo' });
  seedEntry(srv.db, { type: 'gotcha', category: 'Reference', title: 'Gamma gotcha', module: 'other' });
});
after(() => srv.close());

const get = async (p) => stable(await (await fetch(srv.baseUrl + p)).json());

test('golden: search all', async () => {
  matchSnapshot('rest_search_all', await get('/api/collab/search'));
});
test('golden: search by module', async () => {
  matchSnapshot('rest_search_module_demo', await get('/api/collab/search?module=demo'));
});
test('golden: search by category', async () => {
  matchSnapshot('rest_search_category_reference', await get('/api/collab/search?category=Reference'));
});
test('golden: stats', async () => {
  matchSnapshot('rest_stats', await get('/api/collab/stats'));
});
test('golden: modules', async () => {
  matchSnapshot('rest_modules', await get('/api/collab/modules'));
});
test('golden: module-card demo', async () => {
  matchSnapshot('rest_module_card_demo', await get('/api/collab/module-card?slug=demo'));
});
test('golden: doctor', async () => {
  const res = await fetch(srv.baseUrl + '/api/collab/doctor', { method: 'POST' });
  matchSnapshot('rest_doctor', stable(await res.json()));
});
