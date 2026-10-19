// UI parity Task 11: the Settings page. This laptop, the post office's
// address (collab sync set-address) and start-at-login (collab sync autostart),
// through the courier's own functions. The courier folder is a temp one.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { startTeamServer } from './helpers/team-server.mjs';

let srv: any;
let core: any;
const saved = process.env.COLLAB_COURIER_DIR;
before(async () => {
  srv = await startTeamServer();
  core = await import('@collab-mcp/core');
  process.env.COLLAB_COURIER_DIR = path.join(srv.root, 'courier');
});
after(async () => {
  if (saved === undefined) delete process.env.COLLAB_COURIER_DIR; else process.env.COLLAB_COURIER_DIR = saved;
  await srv.close();
});

test('settings: the notebook, the device id, the name the office knows, and the post office', async () => {
  const r = await srv.api('/api/settings');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.device_id, srv.a.device);
  assert.equal(r.body.name, 'a');
  assert.equal(r.body.name_error, null);
  assert.equal(r.body.post_office.url, core.getSyncValue(srv.db, core.SYNC_KEYS.url));
  assert.equal(path.resolve(r.body.notebook.path), path.resolve(srv.a.path));
  assert.equal(r.body.autostart, null, 'no courier set up in this temp folder');
  assert.equal(r.body.courier_available, true);
});

test('address: a bad one is a 400; the right one is checked by certificate and saved', async () => {
  const bad = await srv.api('/api/settings/address', { url: 'office:7443' });
  assert.deepEqual([bad.status, bad.body], [400, { error: 'The address must look like https://host:port, e.g. https://192.168.1.40:7443' }]);
  const url = core.getSyncValue(srv.db, core.SYNC_KEYS.url);
  const ok = await srv.api('/api/settings/address', { url: `${url}/` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.url, url);
  const dead = await srv.api('/api/settings/address', { url: 'https://127.0.0.1:1' });
  assert.equal(dead.status, 409);
  assert.match(dead.body.error, /^Could not reach a post office at https:\/\/127\.0\.0\.1:1 .*Nothing changed\.$/);
  assert.equal(core.getSyncValue(srv.db, core.SYNC_KEYS.url), url, 'unchanged');
});

test('autostart without a courier set up: a plain 409, nothing registered', async () => {
  const r = await srv.api('/api/settings/autostart', { on: true });
  assert.deepEqual([r.status, r.body], [409, { error: "This laptop isn't set up for sync yet, so there is nothing to start at login." }]);
  const bad = await srv.api('/api/settings/autostart', { on: 'yes' });
  assert.equal(bad.status, 400);
});

// Last: the office stays down.
test('office down: the name is unavailable, the rest still shows', async () => {
  await srv.office.down();
  const r = await srv.api('/api/settings');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.name, r.body.device_id], [null, srv.a.device]);
  assert.equal(r.body.name_error, "Name unavailable: the post office can't be reached right now.");
});
