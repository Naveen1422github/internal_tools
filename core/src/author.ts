import { userInfo } from "node:os";

/** Who owns this machine's writes (decision D2). Distinct from `agent`. */
export function resolveAuthor(): string | null {
  const fromEnv = process.env.COLLAB_AUTHOR?.trim();
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username || null;
  } catch {
    return null; // userInfo throws on some sandboxed/containerised hosts
  }
}
