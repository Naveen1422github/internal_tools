#!/usr/bin/env node
/**
 * Collab DB backup — consistent online snapshot + gzip + retention.
 *
 * WHY THIS EXISTS
 *   collab.db is gitignored. Git is not a recovery path. If this file is lost,
 *   537+ entries of architecture decisions, gotchas and design rationale are gone.
 *
 * WHY NOT `cp collab.db`
 *   The DB runs in WAL mode, so its state is split across three files:
 *     collab.db      settled pages
 *     collab.db-wal  recent commits not yet folded in  (currently ~4 MB!)
 *     collab.db-shm  cross-process coordination
 *   A plain file copy sees only the first one and can capture a stale or
 *   half-written snapshot. `VACUUM INTO` goes through SQLite's engine: it merges
 *   the WAL, takes a consistent point-in-time view, and drops free pages —
 *   all while the MCP server keeps running. No downtime, no torn reads.
 *
 * USAGE
 *   node scripts/backup-collab.mjs            # snapshot -> $COLLAB_BACKUP_DIR
 *   node scripts/backup-collab.mjs --force    # ignore the unchanged-DB guard
 *   node scripts/backup-collab.mjs --dry-run  # show what would happen
 *
 * DESTINATION
 *   Set COLLAB_BACKUP_DIR to any folder. Point it at a Google Drive for Desktop
 *   folder (e.g. G:/My Drive/collab-backups) and syncing is handled by Drive —
 *   this script stays unchanged. Defaults to ./backups when unset.
 */

import Database from 'better-sqlite3';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(HERE, '..', 'collab.db');
const BACKUP_DIR = process.env.COLLAB_BACKUP_DIR
  ? path.resolve(process.env.COLLAB_BACKUP_DIR)
  : path.resolve(HERE, '..', 'backups');
const MANIFEST = path.join(BACKUP_DIR, '.last-backup.json');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const DRY_RUN = args.has('--dry-run');

const log = (...m) => console.log('[collab-backup]', ...m);
const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};
// SQLite string literal: forward slashes, and '' escapes an embedded quote.
const sqlPath = (p) => `'${p.replace(/\\/g, '/').replace(/'/g, "''")}'`;

/**
 * Cheap fingerprint of the live DB, used to skip redundant snapshots.
 * Because this runs on every SessionEnd, most invocations should be no-ops.
 */
function fingerprint(db) {
  const { c, m } = db.prepare('SELECT COUNT(*) c, MAX(created_at) m FROM entries').get();
  const t = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
  return { entries: c, newest: m, tasks: t, bytes: fs.statSync(DB_PATH).size };
}

const readManifest = () => {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; }
};

/**
 * Decide which backups to delete.
 *
 * `backups` is newest-first: [{ name, fullPath, date: Date, bytes: number }, ...]
 * Return the subset to delete. Return [] to keep everything.
 *
 * ---------------------------------------------------------------------------
 * TODO(Naveen): implement the retention policy — this is your call to make.
 *
 * The trade-off is recovery window vs. clutter. Some shapes to consider:
 *
 * POLICY: keep the last 2 (Naveen, 2026-09-09). ~2.4 MB total.
 *
 * Understand the window this buys you. Because this fires on SessionEnd, "2
 * backups" means roughly "the last two working sessions" — which on a busy day
 * can be a couple of hours, not two days. Anything wrong that you don't notice
 * within two sessions (a bad bulk edit, an accidental archive, a migration that
 * quietly drops rows) has no clean copy left to recover from.
 *
 * If that window ever feels too tight, the cheapest upgrade is to keep the last 2
 * PLUS the oldest surviving backup, which costs one extra file (~1.2 MB) and gives
 * you a far-back anchor. See KEEP_ANCHOR below.
 * ---------------------------------------------------------------------------
 */
const KEEP_RECENT = 2;
const KEEP_ANCHOR = false; // flip to true to also retain the oldest backup

function selectBackupsToDelete(backups, now) {
  const doomed = backups.slice(KEEP_RECENT);          // backups is newest-first
  if (KEEP_ANCHOR) doomed.pop();                      // spare the oldest
  return doomed;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^collab-\d{4}-\d{2}-\d{2}_\d{4}\.db\.gz$/.test(f))
    .map((name) => {
      const full = path.join(BACKUP_DIR, name);
      const [, y, mo, d, hh, mm] = name.match(/^collab-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\.db\.gz$/);
      return {
        name,
        fullPath: full,
        date: new Date(+y, +mo - 1, +d, +hh, +mm),
        bytes: fs.statSync(full).size,
      };
    })
    .sort((a, b) => b.date - a.date);
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    log('no DB at', DB_PATH, '— nothing to do');
    return 0;
  }

  const live = new Database(DB_PATH, { readonly: true });
  const fp = fingerprint(live);
  const prev = readManifest();

  if (!FORCE && prev && prev.fingerprint
      && prev.fingerprint.entries === fp.entries
      && prev.fingerprint.newest === fp.newest
      && prev.fingerprint.tasks === fp.tasks) {
    log(`unchanged since ${prev.at} (${fp.entries} entries) — skipping`);
    live.close();
    return 0;
  }

  log(`live: ${fp.entries} entries, ${fp.tasks} tasks, newest ${fp.newest}`);
  if (DRY_RUN) { log('--dry-run: would snapshot to', BACKUP_DIR); live.close(); return 0; }

  // A typo'd Drive path must fail loudly, not quietly become a local folder.
  // recursive:true is exactly what would let "G:/My Drve/..." look like success.
  if (process.env.COLLAB_BACKUP_DIR && !fs.existsSync(path.dirname(BACKUP_DIR))) {
    throw new Error(
      `COLLAB_BACKUP_DIR parent does not exist: ${path.dirname(BACKUP_DIR)}\n` +
      `  Refusing to create it — this usually means the Drive path is wrong or\n` +
      `  Google Drive for Desktop is not mounted. Nothing was backed up.`);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const base = `collab-${stamp(new Date())}`;
  const tmp = path.join(BACKUP_DIR, `${base}.db.tmp`);
  const final = path.join(BACKUP_DIR, `${base}.db.gz`);
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

  // Consistent online snapshot — merges the WAL, compacts, server stays up.
  live.exec(`VACUUM INTO ${sqlPath(tmp)}`);
  live.close();

  // Verify BEFORE compressing. A backup you have never opened is not a backup.
  const snap = new Database(tmp, { readonly: true, fileMustExist: true });
  const ok = snap.pragma('integrity_check')[0].integrity_check;
  const got = snap.prepare('SELECT COUNT(*) c FROM entries').get().c;
  snap.close();
  if (ok !== 'ok') throw new Error(`snapshot failed integrity_check: ${ok}`);
  if (got !== fp.entries) throw new Error(`snapshot has ${got} entries, expected ${fp.entries}`);

  const raw = fs.readFileSync(tmp);
  fs.writeFileSync(final, gzipSync(raw, { level: 9 }));
  fs.unlinkSync(tmp);

  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  log(`verified ok (${got} entries) — ${path.basename(final)}  ${mb(fp.bytes)} MB live -> ${mb(raw.length)} MB vacuumed -> ${mb(fs.statSync(final).size)} MB gz`);

  fs.writeFileSync(MANIFEST, JSON.stringify(
    { at: new Date().toISOString(), file: path.basename(final), fingerprint: fp }, null, 2));

  const doomed = selectBackupsToDelete(listBackups(), new Date());
  for (const b of doomed) { fs.unlinkSync(b.fullPath); log('pruned', b.name); }

  const kept = listBackups();
  log(`${kept.length} backup(s) in ${BACKUP_DIR}`);
  if (!process.env.COLLAB_BACKUP_DIR) {
    log('note: COLLAB_BACKUP_DIR unset — backups are LOCAL ONLY, not synced to Drive');
  }
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error('[collab-backup] FAILED:', err.message);
  process.exit(1);
}
