import { accessSync, constants, existsSync } from "node:fs";
import { relative, isAbsolute, join } from "node:path";
import { describeResolution, NoNotebookError, resolveDbPath, UnknownNotebookError } from "../db.js";
import { installRoot } from "../install-root.js";
import { NotebookConfigError } from "../notebooks.js";
import type { GroupState, SetupCheck, SetupContext } from "./types.js";

const G = "notebook" as const;

/** The message as a plain sentence: no "[collab] " prefix and no trailing "Fix: …" (that goes in `fix`). */
function plain(msg: string): string {
  return msg.replace(/^\[collab(-mcp)?\] /, "").replace(/\s*Fix(?: the file by hand)?[:( ].*$/s, "").replace(/\.$/, "");
}

function choiceError(e: unknown): SetupCheck {
  const msg = (e as Error).message;
  if (e instanceof NoNotebookError) {
    return {
      group: G, id: "notebook.choice", mark: "error", text: plain(msg),
      fix: e.known.length
        ? `collab notebook default <name>, or add a .collab file with "notebook = <name>" to the project folder`
        : "collab notebook adopt <path-to-collab.db> --name <name>, or collab notebook new <name>",
    };
  }
  if (e instanceof UnknownNotebookError) {
    return { group: G, id: "notebook.choice", mark: "error", text: plain(msg), fix: "fix the name, or register the notebook with collab notebook adopt <path> --name <name>" };
  }
  if (e instanceof NotebookConfigError) {
    return { group: G, id: "notebook.choice", mark: "error", text: plain(msg), fix: `fix ${e.file} by hand (it is never rewritten automatically); COLLAB_DB_PATH still works meanwhile` };
  }
  return { group: G, id: "notebook.choice", mark: "error", text: plain(msg), fix: 'put one line "notebook = <name>" in the .collab file' };
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function checkNotebook(ctx: SetupContext, st: GroupState): SetupCheck[] {
  const out: SetupCheck[] = [];
  try {
    st.resolution = resolveDbPath(undefined, { cwd: ctx.cwd, env: ctx.env, dataDir: ctx.dataDir });
  } catch (e) {
    return [choiceError(e)];
  }
  const r = st.resolution;
  out.push({ group: G, id: "notebook.choice", mark: "ok", text: describeResolution(r) });

  const tryCheck = (id: string, fn: () => SetupCheck | null) => {
    try { const c = fn(); if (c) out.push(c); }
    catch (e) { out.push({ group: G, id, mark: "error", text: `doctor could not run this check: ${(e as Error).message}` }); }
  };

  tryCheck("notebook.file", () => {
    if (!existsSync(r.path)) {
      return { group: G, id: "notebook.file", mark: "error", text: `No notebook file at ${r.path}`, fix: "collab notebook adopt <path> --name <name> or collab notebook new <name>" };
    }
    try { accessSync(r.path, constants.W_OK); } catch {
      return { group: G, id: "notebook.file", mark: "error", text: `The notebook file at ${r.path} can't be written`, fix: "check the file's permissions, or close whatever holds it read-only" };
    }
    return { group: G, id: "notebook.file", mark: "ok", text: `Notebook file ${r.path}` };
  });

  tryCheck("notebook.location", () => {
    const root = installRoot();
    if (!inside(r.path, root)) return null;
    const text = "This notebook is inside the collab install folder; an update would put it at risk";
    const fix = "move it with collab's help: copy it elsewhere, then collab notebook adopt <new path> --name <name>";
    return existsSync(join(root, ".git"))
      ? { group: G, id: "notebook.location", mark: "warn", text: `${text} (fine for a repo checkout, not for an installed package)`, fix }
      : { group: G, id: "notebook.location", mark: "error", text, fix };
  });

  tryCheck("notebook.clash", () =>
    r.clash
      ? {
          group: G, id: "notebook.clash", mark: "error",
          text: `COLLAB_DB_PATH sends notes to ${r.path}, but ${r.clash.collabFile} says notebook "${r.clash.collabName}"`,
          fix: "remove COLLAB_DB_PATH from this program's settings (e.g. the collab entry in .mcp.json)",
        }
      : null,
  );

  tryCheck("notebook.unregistered", () =>
    r.name === null
      ? { group: G, id: "notebook.unregistered", mark: "warn", text: "This notebook isn't in collab's list", fix: `collab notebook adopt "${r.path}" --name <name>` }
      : null,
  );
  return out;
}
