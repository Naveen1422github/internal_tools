// file: post-office/test/schema-guard.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { requestJson, SchemaMismatchError, latestMigration } from '@collab-mcp/core';
import { office } from './office.js';
import { tempStore } from './helpers.js';

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

test('a schema the office lists is served; an unlisted one is refused (real server)', async () => {
  const probe = tempStore();
  const current = latestMigration(probe.store)!;
  probe.cleanup();
  const o = await office(0, { schemaTable: { [current]: ['0012_older'] } });
  try {
    const m = await o.join('a');
    const ok = await requestJson({ ...o.target(m), schema: '0012_older' }, 'GET', '/v1/modules');
    assert.equal(ok.status, 200);
    await assert.rejects(requestJson({ ...o.target(m), schema: '0011_other' }, 'GET', '/v1/modules'),
      (e: any) => e instanceof SchemaMismatchError && e.device === '0011_other' && e.office === current);
  } finally { await o.stop(); }
});
