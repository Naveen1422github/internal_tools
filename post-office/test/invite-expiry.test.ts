// file: post-office/test/invite-expiry.test.ts
// UI parity D2: adding a member answers when the join code expires, so the web
// page doesn't hard-code "7 days". An additive field: older laptops ignore it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '@collab-mcp/core';
import { office } from './office.js';

test('POST /v1/office/members answers device_id, secret and expires_at (the stored expiry, UTC)', async () => {
  const o = await office();
  try {
    const n = await o.join('N');
    const r = await requestJson(o.target(n), 'POST', '/v1/office/members', { name: 'Rinku' });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['device_id', 'expires_at', 'secret']);
    const stored = (o.store.prepare(`SELECT join_expires_at FROM po_members WHERE device_id = ?`).get(r.body.device_id) as { join_expires_at: string }).join_expires_at;
    assert.equal(r.body.expires_at, stored);
    const hours = (Date.parse(stored.replace(' ', 'T') + 'Z') - Date.now()) / 3_600_000;
    assert.ok(hours > 167 && hours <= 168, `about 7 days ahead (${hours} h)`);
  } finally { await o.stop(); }
});
