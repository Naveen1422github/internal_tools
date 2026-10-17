import {
  closeDb, findProject, formatJoinCode, getDb, postOfficeTargetFromDb, requestJson, type PostOfficeTarget,
} from "@collab-mcp/core";
import type { CliResult, Io } from "./io.js";

// `collab team ...` (RnR S1, R13): who is in a team project and what role they
// hold, asked of the post office. The office decides; this only asks and prints.

const USAGE = `usage: collab team list <CODE>
       collab team set <member> <CODE> <role>
       collab team remove <member> <CODE>
       collab team office-role <member> <role>
       collab team invite <name>
       collab team revoke <member>
  <member> is a device id or a member's name.`;

class Refusal extends Error {}
const refuse = (msg: string): never => { throw new Refusal(msg); };

interface Ctx { target: PostOfficeTarget; db: ReturnType<typeof getDb> }

function context(): Ctx {
  const db = getDb();
  const target = postOfficeTargetFromDb(db);
  if (!target) refuse("this notebook is not sharing with a post office (collab sync setup <join code>)");
  return { db, target: target! };
}

/** One request; any refusal is the office's plain message. */
async function ask(c: Ctx, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<any> {
  const r = await requestJson(c.target, method, path, body);
  if (r.status >= 400) refuse(String(r.body?.error ?? `the post office answered ${r.status}`));
  return r.body;
}

function teamProject(c: Ctx, code: string): { ulid: string; code: string; name: string } {
  const p = findProject(c.db, code);
  if (!p) return refuse(`no project ${code} in this notebook`);
  if (p.mode !== "team") return refuse(`${p.code} is a solo project: it has no team or roles`);
  return p;
}

/** A device id, or a name that picks exactly one member (same style as revoking by name). */
async function resolveMember(c: Ctx, who: string): Promise<string> {
  const body = await ask(c, "GET", "/v1/status");
  const rows = (body.members ?? []) as Array<{ device_id: string; name: string; state: string }>;
  const hit = rows.filter((m) => m.state !== "revoked" && (m.device_id === who || m.name === who));
  if (hit.length === 1) return hit[0].device_id;
  if (hit.length > 1) return refuse(`${hit.length} members are called ${who}; use the device id: ${hit.map((r) => r.device_id).join(", ")}`);
  return refuse(`no member called ${who}`);
}

const enc = encodeURIComponent;

export async function runTeam(args: string[], io: Io): Promise<CliResult> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "list": {
        if (rest.length !== 1) { io.err(USAGE); return { code: 2 }; }
        const c = context();
        const p = teamProject(c, rest[0]);
        const m = await ask(c, "GET", `/v1/projects/${enc(p.ulid)}/members`);
        io.out(`${p.code} (${p.name})`);
        io.out(`${"DEVICE".padEnd(14)}${"NAME".padEnd(22)}${"ROLE".padEnd(18)}LAST SEEN`);
        for (const x of m.members as Array<{ device_id: string; name: string; role: string; last_seen_at: string | null }>) {
          io.out(`${x.device_id.padEnd(14)}${x.name.padEnd(22)}${x.role.padEnd(18)}${x.last_seen_at ?? "-"}`);
        }
        io.out(`Roles in ${p.code}:`);
        for (const r of m.roles as Array<{ name: string; keys: string[] }>) io.out(`  ${r.name}: ${r.keys.join(", ")}`);
        return { code: 0 };
      }
      case "set":
      case "remove": {
        if (rest.length < (sub === "set" ? 3 : 2)) { io.err(USAGE); return { code: 2 }; }
        const c = context();
        const [who, code] = rest;
        const p = teamProject(c, code);
        const device = await resolveMember(c, who);
        if (sub === "set") {
          const role = rest.slice(2).join(" ");
          await ask(c, "PUT", `/v1/projects/${enc(p.ulid)}/members/${enc(device)}`, { role });
          io.out(`${who} is now ${role} in ${p.code}`);
        } else {
          await ask(c, "DELETE", `/v1/projects/${enc(p.ulid)}/members/${enc(device)}`);
          io.out(`${who} is no longer in ${p.code}`);
        }
        return { code: 0 };
      }
      case "office-role": {
        if (rest.length < 2) { io.err(USAGE); return { code: 2 }; }
        const c = context();
        const device = await resolveMember(c, rest[0]);
        const role = rest.slice(1).join(" ");
        await ask(c, "PUT", `/v1/office/members/${enc(device)}`, { role });
        io.out(`${rest[0]} is now ${role} in this office`);
        return { code: 0 };
      }
      case "invite": {
        const name = rest.join(" ").trim();
        if (!name) { io.err(USAGE); return { code: 2 }; }
        const c = context();
        const r = await ask(c, "POST", "/v1/office/members", { name });
        const code = formatJoinCode({ url: c.target.url, fingerprint: c.target.fingerprint, device: r.device_id, secret: r.secret });
        io.out(`member "${name}" added as ${r.device_id}. One-time join code (treat it like a password):`);
        io.out("");
        io.out(code);
        io.out("");
        io.out("on that machine: collab sync setup <the code above>");
        return { code: 0 };
      }
      case "revoke": {
        if (rest.length !== 1) { io.err(USAGE); return { code: 2 }; }
        const c = context();
        const device = await resolveMember(c, rest[0]);
        await ask(c, "DELETE", `/v1/office/members/${enc(device)}`);
        io.out(`revoked ${rest[0]} (${device}): every request from it is now refused`);
        return { code: 0 };
      }
      default:
        io.err(USAGE);
        return { code: 2 };
    }
  } catch (e) {
    io.err(`collab: ${(e as Error).message.replace(/^\[collab(-mcp)?\] /, "")}`);
    return { code: 1 };
  } finally {
    closeDb();
  }
}
