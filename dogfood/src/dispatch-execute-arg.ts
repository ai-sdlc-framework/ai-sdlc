/**
 * Argument-form parser for `/ai-sdlc execute <arg>` and `pnpm watch --issue <arg>`.
 *
 * AISDLC-393 — `/ai-sdlc execute` and the watcher both need to detect whether
 * the operator passed:
 *
 *   - A prefixed backlog task ID (e.g. `AISDLC-NN`, `INGEST-42`, `aisdlc-100.5`)
 *     → existing backlog-task path. No behavior change.
 *   - A bare numeric / `#`-prefixed numeric (e.g. `612`, `#612`)
 *     → GitHub-issue path.
 *   - An explicit `gh:<n>` prefix (e.g. `gh:612`)
 *     → unambiguous GitHub-issue path (when the operator wants to be explicit
 *     even though `612` alone would also route to the GH path).
 *
 * The parser is **pure** (no IO, no env reads) so it can be exercised by
 * hermetic tests in dogfood/src/dispatch-execute-arg.test.ts and re-used
 * from any consumer that needs the same arg form (the slash command body's
 * shell wrapper invokes it via `node -e`-style or a small CLI bin if needed;
 * today the regex shape is documented in the body itself and `parseExecuteArg`
 * is the JS-level reference implementation other consumers import).
 *
 * @module dispatch-execute-arg
 */

/**
 * Discriminated union returned by `parseExecuteArg`.
 *
 *  - `kind: 'backlog-task'` — the canonical backlog task ID (preserving the
 *    operator's original casing for downstream consumers that case-normalise
 *    themselves). The `id` field is the original input minus any trailing
 *    whitespace.
 *
 *  - `kind: 'gh-issue'` — a GitHub issue. The `issueNumber` field is the
 *    parsed positive integer; `originalArg` preserves what the operator
 *    typed so error messages can quote it back verbatim.
 */
export type ExecuteArgKind =
  | { kind: 'backlog-task'; id: string }
  | { kind: 'gh-issue'; issueNumber: number; originalArg: string };

/**
 * AC-6 (AISDLC-393) — when `parseExecuteArg` cannot determine the form,
 * it throws an `ExecuteArgParseError` with `message` listing the accepted
 * forms. Callers that need to render the error nicely (the slash command
 * body, the watcher, the dispatch helper) re-render `error.message` to
 * stderr and exit 1.
 *
 * The class extends `Error` (not just a plain `Error`) so test assertions
 * can distinguish a parse error from any other thrown `Error` via
 * `err instanceof ExecuteArgParseError`.
 */
export class ExecuteArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecuteArgParseError';
  }
}

/**
 * AC-1 (AISDLC-393) — three regex shapes, evaluated in this exact order:
 *
 *   1. `^gh:\d+$` — explicit GH-issue (highest precedence — operator-unambiguous)
 *   2. `^[A-Za-z][A-Za-z0-9]*-\d+(\.\d+)*$` — prefixed backlog task ID
 *   3. `^#?\d+$` — bare numeric / hash-prefixed → GH-issue
 *
 * Order matters for one edge case only: `gh:42` matches both regex 1 and
 * the loose-numeric one if you strip the prefix. Putting `gh:` first means
 * the explicit form always wins. Backlog IDs with hierarchical sub-task
 * markers (e.g. `AISDLC-100.5`) are matched by allowing `(\.\d+)*` at the
 * end of regex 2 — this matches what `validateTask` already accepts in
 * pipeline-cli (it does case-insensitive filename matching via `findTaskFile`).
 *
 * Whitespace is trimmed before matching. Empty input is rejected with
 * the same "no accepted form" error as e.g. `"random garbage"` — the
 * caller doesn't need a separate empty-string check.
 */
export function parseExecuteArg(rawArg: unknown): ExecuteArgKind {
  if (typeof rawArg !== 'string') {
    throw new ExecuteArgParseError(formatRejection(String(rawArg)));
  }
  const arg = rawArg.trim();
  if (arg === '') {
    throw new ExecuteArgParseError(formatRejection(rawArg));
  }

  // 1. Explicit `gh:<n>` — highest precedence so the operator-unambiguous
  //    form always wins.
  const ghPrefixMatch = arg.match(/^gh:(\d+)$/);
  if (ghPrefixMatch) {
    const n = Number(ghPrefixMatch[1]);
    if (n <= 0) {
      throw new ExecuteArgParseError(formatRejection(rawArg));
    }
    return { kind: 'gh-issue', issueNumber: n, originalArg: arg };
  }

  // 2. Prefixed backlog task ID. We allow optional dotted sub-IDs (e.g.
  //    `AISDLC-100.5`) so legacy task hierarchies still parse — these
  //    are valid task filenames per `validateTask`'s `findTaskFile` lookup.
  if (/^[A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)*$/.test(arg)) {
    return { kind: 'backlog-task', id: arg };
  }

  // 3. Bare numeric / `#`-prefixed numeric → GH issue. We strip a single
  //    leading `#` if present, then parse as a positive integer.
  const bareMatch = arg.match(/^#?(\d+)$/);
  if (bareMatch) {
    const n = Number(bareMatch[1]);
    if (n <= 0) {
      throw new ExecuteArgParseError(formatRejection(rawArg));
    }
    return { kind: 'gh-issue', issueNumber: n, originalArg: arg };
  }

  // No form matched — surface the canonical rejection message so the
  // operator sees the accepted forms.
  throw new ExecuteArgParseError(formatRejection(rawArg));
}

/**
 * Canonical rejection message — AC-6. Quotes the operator's input back so
 * they can see exactly what was rejected (helps when the rejection is due
 * to invisible whitespace or a typo).
 */
function formatRejection(rawArg: unknown): string {
  const quoted = typeof rawArg === 'string' ? `'${rawArg}'` : String(rawArg);
  return [
    `Invalid execute argument ${quoted} — expected one of:`,
    `  - <prefix>-<number>   e.g. 'AISDLC-393', 'INGEST-42' (backlog task ID)`,
    `  - <number> or #<number>   e.g. '612', '#612' (GitHub issue number)`,
    `  - gh:<number>   e.g. 'gh:612' (explicit GitHub issue routing)`,
  ].join('\n');
}
