// file: post-office/test/office.ts
import assert from 'node:assert';
import { generateSelfSignedCert, requestJson, latestMigration, type PostOfficeTarget } from '@collab-mcp/core';
import { tempStore } from './helpers.js';
import { addMember } from '../src/store.js';
import { startPostOffice } from '../src/server.js';

/** A running post office on 127.0.0.1 with a temp store; `join(name)` registers + joins a member. */
export async function office(seed = 0, extra: Record<string, unknown> = {}) {
  const t = tempStore(seed);
  const cert = generateSelfSignedCert();
  const po = await startPostOffice({ store: t.store, certPem: cert.certPem, keyPem: cert.keyPem, host: '127.0.0.1', port: 0, heartbeatMs: 50, revokeCheckMs: 50, ...extra });
  const target = (auth?: { device: string; key: string }): PostOfficeTarget =>
    ({ url: po.url, fingerprint: cert.fingerprint, auth, schema: latestMigration(t.store) ?? undefined });
  const join = async (name: string) => {
    const { deviceId, secret } = addMember(t.store, name);
    const r = await requestJson({ url: po.url, fingerprint: cert.fingerprint }, 'POST', '/v1/join', { device: deviceId, secret }); // no schema header: join is not checked
    assert.equal(r.status, 200);
    return { device: deviceId, key: r.body.key as string, secret };
  };
  return { ...t, po, cert, target, join, stop: async () => { await po.close(); t.cleanup(); } };
}

