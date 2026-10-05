// The one way to print a note number in the web UI. Mirrors
// core/src/entry-ref.ts exactly (the UI doesn't import core); keep them in step.
export function formatEntryRef(id: number | null | undefined, series = "E"): string {
  if (id === null || id === undefined) return `${series}-?`;
  return `${series}-${String(id).padStart(5, "0")}`;
}

// Mirrors parseEntryRef in core/src/ulid.ts (same whitespace set, same
// pattern): "214", "#214", "E-214", "E214", "E-00214" -> 214; anything else -> null.
const REF_WHITESPACE = " \t\n\u000B\f\r\u00a0";
const TRIM_REF_RE = new RegExp(`^[${REF_WHITESPACE}]+|[${REF_WHITESPACE}]+$`, "g");

export function parseEntryRef(value: string): number | null {
  const trimmed = value.replace(TRIM_REF_RE, "");
  const m = /^(?:#|E-?)?(\d+)$/i.exec(trimmed);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
