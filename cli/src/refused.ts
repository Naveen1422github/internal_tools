import { closeDb, copyRefused, describeRefused, discardRefused, formatEntryRef, getDb, listRefused } from "@collab-mcp/core";
import type { CliResult, Io } from "./io.js";
import { failPlain } from "./io.js";

// `collab refused ...` (RnR S2, R6 / rule 5): changes the post office turned
// down are kept on this laptop. List them, copy one into a solo project, or
// discard it. Nothing a person typed is lost silently.

const USAGE = `usage: collab refused list
       collab refused copy <id> --to <SOLO CODE>
       collab refused delete <id>`;

export async function runRefused(args: string[], io: Io): Promise<CliResult> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "list": {
        if (rest.length) { io.err(USAGE); return { code: 2 }; }
        const db = getDb();
        const rows = listRefused(db);
        if (!rows.length) { io.out("Nothing was refused."); return { code: 0 }; }
        io.out(`${"ID".padEnd(28)}${"WHEN".padEnd(21)}${"PROJECT".padEnd(9)}${"KIND".padEnd(6)}${"NOTE".padEnd(26)}REASON`);
        for (const r of rows) {
          const { note, project_code } = describeRefused(db, r);
          io.out(`${r.ulid.padEnd(28)}${r.at.padEnd(21)}${project_code.padEnd(9)}${r.kind.padEnd(6)}${note.padEnd(26)}${r.reason}`);
        }
        return { code: 0 };
      }
      case "copy": {
        const id = rest[0];
        const to = rest[1] === "--to" ? rest[2] : undefined;
        if (!id || !to || rest.length !== 3) { io.err(USAGE); return { code: 2 }; }
        const r = await copyRefused(getDb(), id, to);
        io.out(formatEntryRef(r.id, r.series));
        return { code: 0 };
      }
      case "delete": {
        if (rest.length !== 1) { io.err(USAGE); return { code: 2 }; }
        discardRefused(getDb(), rest[0]);
        io.out("deleted");
        return { code: 0 };
      }
      default:
        io.err(USAGE);
        return { code: 2 };
    }
  } catch (e) {
    return failPlain(io, e);
  } finally {
    closeDb();
  }
}
