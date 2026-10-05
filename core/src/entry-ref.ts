// file: core/src/entry-ref.ts
// The one way to print a note number. ui/src/format.ts mirrors this: the UI
// doesn't import core. Only the E series is zero-padded (as it always was);
// project series print the bare number: E-00760, SH-12.
import type { NoteRef } from "./ulid.js";

export function formatEntryRef(id: number | null | undefined, series = "E"): string {
  if (id === null || id === undefined) return `${series}-?`;
  return series === "E" ? `${series}-${String(id).padStart(5, "0")}` : `${series}-${id}`;
}

export function formatNoteRef(ref: NoteRef): string {
  return formatEntryRef(ref.id, ref.series);
}
