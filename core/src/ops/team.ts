// file: core/src/ops/team.ts
// `collab team list <CODE>`'s words, shared with the MCP tool collab_team_list
// (UI parity Task 7d). The roster itself is the office's answer to
// GET /v1/projects/:p/members: the office decides who is in a project.

export interface TeamRosterLines {
  members: Array<{ device_id: string; name: string; role: string; last_seen_at: string | null }>;
  roles: Array<{ name: string; keys: string[] }>;
}

/** `collab team list <CODE>`, line for line. */
export function teamListLines(p: { code: string; name: string }, roster: TeamRosterLines): string[] {
  const out = [`${p.code} (${p.name})`, `${"DEVICE".padEnd(14)}${"NAME".padEnd(22)}${"ROLE".padEnd(18)}LAST SEEN`];
  for (const x of roster.members) out.push(`${x.device_id.padEnd(14)}${x.name.padEnd(22)}${x.role.padEnd(18)}${x.last_seen_at ?? "-"}`);
  out.push(`Roles in ${p.code}:`);
  for (const r of roster.roles) out.push(`  ${r.name}: ${r.keys.join(", ")}`);
  return out;
}
