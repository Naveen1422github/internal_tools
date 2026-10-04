// file: post-office/test/schema-guard.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { requestJson, SchemaMismatchError, latestMigration } from '@collab-mcp/core';
import { office } from './office.js';

test('/v1/join is not schema-checked; a request with the office schema is served', async () => {
  const o = await office();
  try {
    const m = await o.join('a'); // join() asserts 200 with no schema header
    const r = await requestJson({ ...o.target(m), schema: latestMigration(o.store)! }, 'GET', '/v1/modules');
    assert.equal(r.status, 200);
  } finally { await o.stop(); }
});

test('a different schema is refused with 409 and becomes SchemaMismatchError', async () => {
  const o = await office();
  try {
    const m = await o.join('a');
    await assert.rejects(requestJson({ ...o.target(m), schema: '0007_sync_prep' }, 'GET', '/v1/modules'), (e: any) =>
      e instanceof SchemaMismatchError && e.office === latestMigration(o.store) && e.device === '0007_sync_prep' && e.retriable === false);
  } finally { await o.stop(); }
});

test('a request without the schema header is refused (an older courier)', async () => {
  const o = await office();
  try {
    const m = await o.join('a');
    const bare = { url: o.po.url, fingerprint: o.cert.fingerprint, auth: m }; // no schema: an older courier
    await assert.rejects(requestJson(bare, 'POST', '/v1/allocate', { ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
      (e: any) => e instanceof SchemaMismatchError && e.device === 'unknown');
  } finally { await o.stop(); }
});
