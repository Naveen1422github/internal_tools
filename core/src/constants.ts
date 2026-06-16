export type EntryType =
  | "handoff"
  | "review"
  | "proposal"
  | "counter"
  | "decision"
  | "gotcha"
  | "rollup"
  | "session-note"
  | "changelog";
export type Agent = "Claude" | "Codex" | "Gemini" | "User";
export type RefType = "file" | "task" | "entry" | "url";
export type Category = "Index" | "Reference" | "Activity";

export const KIND_BY_TYPE: Record<EntryType, "signal" | "log"> = {
  handoff: "signal",
  review: "signal",
  proposal: "signal",
  counter: "signal",
  decision: "signal",
  gotcha: "signal",
  rollup: "signal",
  "session-note": "log",
  changelog: "log",
};
export const CATEGORY_BY_TYPE: Record<EntryType, Category> = {
  handoff: "Activity",
  review: "Activity",
  proposal: "Activity",
  counter: "Activity",
  decision: "Reference",
  gotcha: "Reference",
  rollup: "Activity",
  "session-note": "Activity",
  changelog: "Activity",
};
// Mirror of the regex enforced in module.ts / the old core/constants.cjs.
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,59}$/;
