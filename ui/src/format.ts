// The one way to print a note number in the web UI. Mirrors
// core/src/entry-ref.ts exactly (the UI doesn't import core); keep them in step.
// Only the E series is zero-padded; project series print the bare number.
export function formatEntryRef(id: number | null | undefined, series = "E"): string {
  if (id === null || id === undefined) return `${series}-pending`; // saved, waiting for its number (stage C)
  return series === "E" ? `${series}-${String(id).padStart(5, "0")}` : `${series}-${id}`;
}

/** A note number with its series (mirror of core's NoteRef). */
export interface NoteRef { series: string; id: number }

export function formatNoteRef(ref: NoteRef): string {
  return formatEntryRef(ref.id, ref.series);
}

/**
 * How to ask the server for a note (stage B1): its number for an E note (as
 * every call did before), "SH-12" for a project note.
 */
export function noteRefOf(e: { id: number; series?: string | null }): number | string {
  return e.series && e.series !== "E" ? formatEntryRef(e.id, e.series) : e.id;
}

// Mirrors parseEntryRef in core/src/ulid.ts (same whitespace set, same
// pattern): "214", "#214", "E-214", "E214", "E-00214" -> 214; anything else -> null.
const REF_WHITESPACE = " \t\n\u000B\f\r ";
const TRIM_REF_RE = new RegExp(`^[${REF_WHITESPACE}]+|[${REF_WHITESPACE}]+$`, "g");

export function parseEntryRef(value: string): number | null {
  const trimmed = value.replace(TRIM_REF_RE, "");
  const m = /^(?:#|E-?)?(\d+)$/i.exec(trimmed);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Mirrors parseNoteRef in core/src/ulid.ts: "760", "#760", "E-00760" -> series
// E; "SH-12", "sh-0012" -> series SH (a project code is checked first).
export function parseNoteRef(value: string): NoteRef | null {
  const s = value.replace(TRIM_REF_RE, "").toUpperCase();
  const code = /^([A-Z][A-Z0-9]{1,7})-(\d+)$/.exec(s);
  const legacy = code ? null : /^(?:#|E-?)?(\d+)$/.exec(s);
  if (!code && !legacy) return null;
  const series = code ? code[1] : "E";
  const id = Number(code ? code[2] : legacy![1]);
  return Number.isSafeInteger(id) && id > 0 ? { series, id } : null;
}
