# OpenCode Runner

Standalone issue-dispatch runner for the **opencode v2** CLI — the
community companion to the in-tree `orchestrator/src/runners/opencode.ts`.

Same dispatch contract (issue-framing prompt → `opencode run
--standalone --auto --format json` → git diff → commit), with ONE
deliberate difference: it performs a **contract retry** on transport
failure, resuming the same session with `--session <id>`. The in-tree
runner never auto-retries (Claude Code precedent); the retry lives here.

- Requirements: Node >= 18, `opencode >= 2.0.0` (`opencode --version` →
  `opencode v2.x.y`), a git worktree provisioned in advance.
- No build step, no dependencies.

## Usage

```bash
node contrib/runners/opencode/runner.mjs \
  --workdir "$WORKTREE" \
  --issue 1234 \
  --title "Add full-text search" \
  --body "The issue description markdown..." \
  --model lmstudio/qwen/qwen3.8-27b \
  --agent developer \
  --retries 1
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--workdir <path>` | pre-provisioned git worktree/checkout (required) | — |
| `--issue <id>` | issue id (required) | — |
| `--title <text>` | issue title (required) | — |
| `--body <text>` | issue description | empty |
| `--model <ref>` | `provider/model[#variant]`; bare ids get an `anthropic/` prefix | `OPENCODE_MODEL` → `AI_SDLC_MODEL` |
| `--agent <name>` | `--agent` for the run | `OPENCODE_AGENT` |
| `--max-files <n>` | max files constraint in the prompt | 10 |
| `--blocked-paths a/**,b/**` | blocked-path constraints | none |
| `--timeout <dur>` | `15m`/`30m`/`1h`/ms | `AI_SDLC_RUNNER_TIMEOUT` or 15m |
| `--retries <n>` | contract retries after a transport failure | 0 |

Env channels (all optional): `OPENCODE_BIN`, `OPENCODE_MODEL`,
`AI_SDLC_MODEL`, `OPENCODE_AGENT`, `AI_SDLC_RUNNER_TIMEOUT`,
`AI_SDLC_LINT_COMMAND`, `AI_SDLC_FORMAT_COMMAND`,
`AI_SDLC_TYPECHECK_COMMAND`, `AI_SDLC_COMMIT_TEMPLATE`,
`AI_SDLC_CO_AUTHOR`, `AI_SDLC_TELEMETRY_DIR`,
`OPENCODE_CONFIG_CONTENT` (inherited; the runner also sets its own).

## Result

Exactly ONE JSON object on **stdout** (diagnostics on stderr):

```json
{
  "success": true,
  "sessionID": "ses_0123abcd",
  "filesChanged": ["src/search.ts"],
  "summary": "Implemented the search index...",
  "commitSha": "9f8e7d6c...",
  "tokenUsage": { "inputTokens": 16032, "outputTokens": 81, "cacheReadTokens": 0 },
  "attempts": 1
}
```

Exit `0` on success, `1` on failure. On failure `filesChanged` is `[]`
and `error` carries the reason; `tokenUsage` is best-effort (the
`session export` of a dead session may still have partial tokens).

## Behavior notes

- `--standalone` is ALWAYS passed — the runner must never attach to a
  background opencode service (see
  [`docs/operations/opencode-harness.md`](../../../docs/operations/opencode-harness.md)).
- Per-dispatch `OPENCODE_CONFIG_CONTENT` injection: `snapshot: false` +
  `autoupdate: false` + the project's `mcp` table with relative local
  command paths re-anchored at the **main clone** root (build artifacts
  are git-ignored and absent from worktrees). Unbuilt entries are dropped.
- `AI_SDLC_ACTIVE_TASK_ID` is set to the issue id and
  `AI_SDLC_PROJECT_ROOT` to the workdir for the in-repo governance plugin.
- Contract retry: on non-zero exit OR (exit 0 + stream error + no final
  text) the runner retries up to `--retries` more times — resuming the
  captured session with `--session <id>` when one was captured, else
  starting fresh. Baseline file snapshots are taken once, before attempt 1,
  so partial writes from a dead attempt are still in the final diff.
- The runner commits locally (template + `Co-Authored-By`) and NEVER
  pushes; pushing is the orchestrator/promotion layer's job.
- Tokens come from `opencode session export --standalone <id>` (authoritative
  local DB read) with stream totals as the fallback.
