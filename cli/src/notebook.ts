import Database from "better-sqlite3";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  addNotebook, closeDb, describeResolution, getDb, hasUlidPrimaryKey, latestMigration, liveEntry, migrate,
  NOTEBOOK_NAME, notebookDataDir, readNotebookConfig, reindexFts, resolveDbPath, setDefaultNotebook,
} from "@collab-mcp/core";
import type { CliResult, Io } from "./io.js";

const fail = (io: Io, msg: string): CliResult => { io.err(`collab: ${msg.replace(/^\[collab(-mcp)?\] /, "")}`); return { code: 1 }; };

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Read-only peek: the newest migration, or null when the file isn't a collab notebook. */
function peekMigration(path: string): string | null {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get();
    return has ? latestMigration(db) ?? "none" : null;
  } finally { db.close(); }
}

function size(path: string): string {
  const b = statSync(path).size;
  return b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`;
}

export async function runNotebook(args: string[], io: Io): Promise<CliResult> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "list": {
        const cfg = readNotebookConfig();
        const names = Object.keys(cfg.notebooks).sort();
        if (!names.length) { io.out("No notebooks yet. Start one: collab notebook new <name>, or register one: collab notebook adopt <path> --name <name>"); return { code: 0 }; }
        for (const n of names) {
          const p = cfg.notebooks[n].path;
          let mig = "missing", sz = "-";
          if (existsSync(p)) {
            try { mig = peekMigration(p) ?? "not a collab notebook"; sz = size(p); } catch (e) { mig = `can't open: ${(e as Error).message}`; }
          }
          io.out(`${cfg.default === n ? "*" : " "} ${n.padEnd(20)} ${mig.padEnd(24)} ${sz.padStart(8)}  ${p}`);
        }
        return { code: 0 };
      }
      case "adopt": {
        const path = rest[0] && !rest[0].startsWith("--") ? resolve(rest[0]) : undefined;
        const name = flag(rest, "--name");
        if (!path || !name) { io.err("usage: collab notebook adopt <path> --name <name>"); return { code: 2 }; }
        if (!existsSync(path)) return fail(io, `no file at ${path}`);
        let mig: string | null;
        try { mig = peekMigration(path); } catch (e) { return fail(io, `${path} isn't a collab notebook (${(e as Error).message})`); }
        if (mig === null) return fail(io, `${path} isn't a collab notebook (it has no schema_migrations table)`);
        addNotebook(name, path);
        io.out(`Added ${name}. It stays where it is: ${path}`);
        return { code: 0 };
      }
      case "new": {
        const name = rest[0];
        if (!name) { io.err("usage: collab notebook new <name>"); return { code: 2 }; }
        if (!NOTEBOOK_NAME.test(name)) return fail(io, `"${name}" is not a valid notebook name: use lowercase letters, digits and hyphens`);
        const cfg = readNotebookConfig();
        if (cfg.notebooks[name]) return fail(io, `a notebook named "${name}" already exists (${cfg.notebooks[name].path})`);
        const path = join(notebookDataDir(name), "notebook.db");
        if (existsSync(path)) return fail(io, `${path} already exists; register it with: collab notebook adopt "${path}" --name ${name}`);
        mkdirSync(dirname(path), { recursive: true });
        // The one place a new empty notebook is created on purpose (spec, collab notebook new).
        closeDb();
        try { migrate(getDb(path, { create: true })); } finally { closeDb(); }
        addNotebook(name, path);
        io.out(`Created ${name}: ${path}`);
        if (readNotebookConfig().default === name) io.out(`It is your default notebook.`);
        return { code: 0 };
      }
      case "default": {
        const name = rest[0];
        if (!name) { io.err("usage: collab notebook default <name>"); return { code: 2 }; }
        setDefaultNotebook(name);
        io.out(`${name} is now the default notebook.`);
        return { code: 0 };
      }
      case "which": {
        const r = resolveDbPath();
        io.out(`${describeResolution(r)}: ${r.path}`);
        return { code: 0 };
      }
      case "reindex": {
        // Never run automatically (spec P11): it rewrites the search index.
        const db = getDb();
        try {
          if (!hasUlidPrimaryKey(db)) return fail(io, "reindex needs a notebook on migration 0006 or later");
          const ulids = (db.prepare(`SELECT ulid FROM entries e WHERE ${liveEntry(db, "e")}`).all() as Array<{ ulid: string }>).map((r) => r.ulid);
          db.transaction(() => reindexFts(db, ulids))();
          io.out(`Reindexed ${ulids.length} note(s).`);
          return { code: 0 };
        } finally { closeDb(); }
      }
      default:
        io.err("usage: collab notebook list | adopt <path> --name <name> | new <name> | default <name> | which | reindex");
        return { code: 2 };
    }
  } catch (e) {
    return fail(io, (e as Error).message);
  }
}
