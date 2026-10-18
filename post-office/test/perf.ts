// Timing gates (R-21): the exact budget only in strict mode; otherwise 3x it, a
// gross-regression smoke that the normal parallel suite can't fail on CPU contention.
// Strict: COLLAB_PERF=1 npx tsx --test --test-concurrency=1 test/<file>.test.ts
export const STRICT = process.env.COLLAB_PERF === '1';

/** The limit a timing test asserts against: `ms` when strict, else 3 * `ms`. */
export function budget(ms: number): number {
  return STRICT ? ms : 3 * ms;
}
