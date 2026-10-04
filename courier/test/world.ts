// file: courier/test/world.ts
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  migrate, enableSync, generateSelfSignedCert, formatJoinCode, hasCrrTables, loadCrsqlite, isCrsqliteLoaded,
  setSyncValue, requestJson, SYNC_KEYS, installSyncPing,
} from '@collab-mcp/core';
import { createStore, closeStore, startPostOffice, addMember, type PostOffice, type Store } from '@collab-mcp/post-office';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(cond: () => boolean, ms = 5000, what = 'the condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(10);
  }
}

export function tempDir(prefix = 'collab-courier-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A writer connection, opened the way core's getDb opens one (cr-sqlite loaded, save ping installed when the DB shares). */
export function openWriter(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  if (hasCrrTables(db)) loadCrsqlite(db);
  installSyncPing(db);
  return db;
}
export function closeWriter(db: Database.Database): void {
  if (!db.open) return;
  if (isCrsqliteLoaded(db)) { try { db.prepare('SELECT crsql_finalize()').get(); } catch { /* closing anyway */ } }
  db.close();
}

export interface Office {
  store: Store;
  readonly po: PostOffice;
  readonly url: string;
  fingerprint: string;
  requests: Array<{ route: string; device: string }>;
  hooks: { dropChangesAnswer?: (device: string) => boolean };
  /** One-time join code for a new member. */
  code(name: string): { code: string; device: string };
  down(): Promise<void>;
  up(): Promise<void>;
  close(): Promise<void>;
}

/** A post office on 127.0.0.1 that can go down and come back on the same port with the same store. */
export async function startOffice(dir: string, seedMaxId: number): Promise<Office> {
  const store = createStore(join(dir, 'office.db'), { seedMaxId });
  const cert = generateSelfSignedCert();
  const requests: Office['requests'] = [];
  const hooks: Office['hooks'] = {};
  const opts = {
    store, certPem: cert.certPem, keyPem: cert.keyPem, host: '127.0.0.1', heartbeatMs: 1000, revokeCheckMs: 100,
    testHooks: {
      onRequest: (route: string, device: string) => { requests.push({ route, device }); },
      dropChangesAnswer: (device: string) => hooks.dropChangesAnswer?.(device) ?? false,
    },
  };
  let po = await startPostOffice({ ...opts, port: 0 });
  const port = po.port;
  let running = true;
  return {
    store, fingerprint: cert.fingerprint, requests, hooks,
    get po() { return po; },
    get url() { return po.url; },
    code(name) {
      const { deviceId, secret } = addMember(store, name);
      return { code: formatJoinCode({ url: po.url, fingerprint: cert.fingerprint, device: deviceId, secret }), device: deviceId };
    },
    async down() { if (running) { running = false; await po.close(); } },
    async up() { if (!running) { po = await startPostOffice({ ...opts, port }); running = true; } },
    async close() { await this.down(); closeStore(store); },
  };
}

/** A shared notes DB joined to `office` WITHOUT the setup command (Tasks 3-4 test the engine alone). */
export async function joinedDb(office: Office, dir: string, name: string): Promise<{ path: string; device: string }> {
  mkdirSync(join(dir, name), { recursive: true });
  const path = join(dir, name, 'collab.db');
  const db = new Database(path);
  try {
    migrate(db); // same migration as the office, or the schema guard refuses it
    enableSync(db);
    const { deviceId, secret } = addMember(office.store, name);
    const r = await requestJson({ url: office.url, fingerprint: office.fingerprint }, 'POST', '/v1/join', { device: deviceId, secret });
    setSyncValue(db, SYNC_KEYS.url, office.url);
    setSyncValue(db, SYNC_KEYS.fingerprint, office.fingerprint);
    setSyncValue(db, SYNC_KEYS.device, deviceId);
    setSyncValue(db, SYNC_KEYS.key, r.body.key);
    return { path, device: deviceId };
  } finally { closeWriter(db); }
}
