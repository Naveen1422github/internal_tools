// file: core/src/entry-ref.ts
// The one way to print a note number (stage A of piece 2; series arrive in
// stage B). ui/src/format.ts mirrors this: the UI doesn't import core.
export function formatEntryRef(id: number | null | undefined, series = "E"): string {
  if (id === null || id === undefined) return `${series}-?`;
  return `${series}-${String(id).padStart(5, "0")}`;
}
