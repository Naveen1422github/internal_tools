import { latestAvailableMigration, latestMigration } from "../db.js";
import { isSyncEnabled } from "../sync/state.js";
import { readSyncOverview } from "../sync/overview.js";
import { courierDir } from "../sync/courier-paths.js";
import type { GroupState, SetupCheck, SetupContext } from "./types.js";

const G = "version" as const;

export function checkNotebookVersion(_ctx: SetupContext, st: GroupState): SetupCheck {
  const have = latestMigration(st.db!) ?? "none";
  const known = latestAvailableMigration() ?? "none";
  if (have === known) return { group: G, id: "version.notebook", mark: "ok", text: `Notebook on ${have}, matches this install` };
  if (have < known) {
    return {
      group: G, id: "version.notebook", mark: "warn", text: `Notebook is on ${have}; this install has ${known}`,
      fix: "collab update (piece 3); until then: npm --prefix mcp run migrate in a checkout",
    };
  }
  return { group: G, id: "version.notebook", mark: "error", text: `This notebook is on ${have} but this install only knows up to ${known}`, fix: "update collab on this computer" };
}

export function checkOfficeVersion(ctx: SetupContext, st: GroupState): SetupCheck | null {
  if (!isSyncEnabled(st.db!)) return null;
  const o = readSyncOverview(st.db!, { courierDir: courierDir(ctx.env), isAlive: ctx.isAlive });
  if (o.enabled && o.courier.state === "needs-update") {
    return {
      group: G, id: "version.office", mark: "error", text: "The post office and this laptop are on different versions; sync is paused",
      fix: "update whichever is older (the post office first)",
    };
  }
  return { group: G, id: "version.office", mark: "ok", text: "In step with the post office (as far as the courier knows)" };
}
