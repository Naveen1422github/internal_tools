// The one way to print a note number in the web UI. Mirrors
// core/src/entry-ref.ts exactly (the UI doesn't import core); keep them in step.
export function formatEntryRef(id: number | null | undefined, series = "E"): string {
  if (id === null || id === undefined) return `${series}-?`;
  return `${series}-${String(id).padStart(5, "0")}`;
}
