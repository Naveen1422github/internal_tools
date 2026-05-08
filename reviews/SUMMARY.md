| session | verdict | top 1 issue | recommended action |
|---|---|---|---|
| T1 - PTY backend | REQUEST_CHANGES | `data/sessions.json:1` commits runtime Jules VM session state even though the file is meant to be gitignored persistence. | Do not apply - re-dispatch or fix T1 issues first. |
| T2 - frontend parity | PULL FAILED | `jules remote pull` failed twice with `Z_BUF_ERROR`; `reviews/t2.diff` is empty and T2 was re-Planning. | Retry pull after Jules finishes. |
| T3 - agent adapters | REQUEST_CHANGES | `tools/agents/codex.js:72` shells out with unescaped profile input. | Apply only after fixing issues 1, 2, and 3 from the review. |
| Performance opt | APPROVE | Only low-risk batching concerns in `collab-mcp/src/tools/add.ts:97`. | Apply via `jules remote pull --session 16112623997324035017 --apply` and push after normal verification. |
| Security fix | APPROVE | `public/app.js:444` can render literal marker strings as highlight markup, but not obvious XSS. | Apply via `jules remote pull --session 6859654469399420307 --apply`, or wait to merge with T2. |
| Testing improvements | NEEDS_DISCUSSION | `reviews/testing.diff:1` says no diff found; session was in progress. | Do not apply - wait or re-dispatch. |

Cross-cutting concerns: T1 and T3 both edit `package.json`, so they have a real merge-conflict risk around scripts/dependencies. Security touches `public/app.js` and `public/index.html`, which are in T2's scope; since T2 failed to pull, the exact frontend conflict is unknown but likely if T2 later completes. Perf is isolated to `collab-mcp/src/tools/add.ts` and `collab-mcp/src/tools/rollup.ts` and does not overlap T1/T2/T3. Testing has no diff, so it currently adds no conflict surface.
