---
name: execute
description: Execute a backlog task OR GitHub issue end-to-end — worktree → developer subagent → parallel reviewer subagents → PR. A thin loop over `ai-sdlc-pipeline next-step`; every deterministic step runs in TypeScript, the main session only spawns agents.
argument-hint: <task-id | gh-issue-number | gh:N | #N>
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Agent(developer, code-reviewer, test-reviewer, security-reviewer)
  - mcp__backlog__task_view
  - mcp__plugin_ai-sdlc_ai-sdlc__task_edit
  - mcp__plugin_ai-sdlc_ai-sdlc__task_complete
model: sonnet
---

Execute work item `$ARGUMENTS` end-to-end. `$ARGUMENTS` is a backlog task ID (`AISDLC-393`, `INGEST-42`) or a GitHub issue (`612`, `#612`, `gh:612`).

You are a **loop driver, not a pipeline narrator** (AISDLC-762). Steps 0-15 (parent self-heal, sweep, validation, dependency preflight, worktree + hooks check, status flip + `.active-task` sentinel, prompts, classifier and incremental-review gates, nonce, transcript persistence, leaf emission, aggregation, iteration, pre-sign rebase, Done + verdicts file, signing, push, DRAFT PR, marker, sibling PRs, `gh pr ready`, cleanup) are implemented and tested in `pipeline-cli/src/next-step/` and `pipeline-cli/src/steps/`. Do not re-implement or second-guess them. Your whole job: call `next-step`, perform the ONE instruction it returns, report the result, repeat.

## Argument forms (AISDLC-393)

| Form | Regex | Path |
| --- | --- | --- |
| Explicit GitHub issue | `^gh:\d+$` | GH-issue (subscription billing, no backlog file, PR closes the issue) |
| Prefixed task id | `^[A-Za-z][A-Za-z0-9]*-\d+(\.\d+)*$` | backlog task |
| Bare / `#`-prefixed number | `^#?\d+$` | GH-issue |

`next-step` classifies the argument (same shapes as `parseExecuteArg` in `dogfood/src/dispatch-execute-arg.ts`) and refuses anything else with the accepted forms. A `gh:<n>` run must be untrusted (AISDLC-720): issue text is outside input, so run it only in a session launched with `AI_SDLC_UNTRUSTED_RUN=1` and `AI_SDLC_UNTRUSTED_REASON='gh-issue source'`. `next-step` runs the whole GH-issue pipeline itself (the `claude` CLI must be on PATH; it never falls back to `ANTHROPIC_API_KEY`) and returns the terminal instruction.

## Hard rules (NEVER violate)

Items 1-4 and 6 are **governance-configurable per repo** (`.ai-sdlc/agent-role.yaml` `spec.governance`, RFC-0048 / AISDLC-601). Run this first and treat its output as authoritative for the session (no `governance:` section means every rule prints its strict text, except force-push which defaults to `allowForcePush: leaseOnOwnBranch`, AISDLC-710). Items 5 and 7 are **fixed integrity floors**, never configurable (RFC-0048 OQ-3).

```bash
node "${CLAUDE_PLUGIN_ROOT:-$(pwd)/ai-sdlc-plugin}/scripts/render-governance-hard-rules.mjs"
```

1. **Merging follows `governance.allowMerge` in `.ai-sdlc/agent-role.yaml`, rendered into the session hard rules; when it permits merging, the only path is `cli-merge-if-eligible`; never run the raw merge command.** Never run `gh pr merge` (any flag form, `--auto` included), and never merge through `gh api .../pulls/<n>/merge` or `curl`. Merge or arm auto-merge only with `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind backlog [--arm]` (AISDLC-603), which re-checks green + CLEAN + trusted source. The PreToolUse hook enforces this regardless of policy.
2. **Never plain force-push; a lease push of this task's own branch is allowed by default (`allowForcePush: leaseOnOwnBranch`).** No `git push --force` / `-f`, ever. `next-step` pushes with a plain `git push -u origin <branch>` and never force-pushes; on non-fast-forward it stops. If you must update the remote after a rebase, use only `git push --force-with-lease origin HEAD:refs/heads/<this task's own branch>` as a single standalone command with the branch written literally, never another branch, never `main`/`master`. When the rendered rules say `Never force-push`, stop and ask the operator instead.
3. **Never close PRs or issues** (`gh pr close`, `gh issue close`) unless the rendered rules say `allowClosePrIssue: true`.
4. **Never delete branches** (`git branch -D` / `-d`) unless the rendered rules say `allowBranchDelete: true`.
5. **Edit governance config (`.ai-sdlc/**`) only when the task names the file and the change; never as a side effect.** Runtime artifacts (attestations, reviews, transcript leaves, verdicts, the decision log, the dispatch board) are written through their CLIs, which `next-step` runs. Runs marked untrusted (`AI_SDLC_UNTRUSTED_RUN`) are blocked from `.ai-sdlc/**` and `.github/workflows/**` by the hook; ask a maintainer in the PR instead of retrying.
6. **Never run `git reset --hard` ad-hoc** unless the rendered rules say `allowResetHard: true`. The sanctioned path is `scripts/check-orchestrator-state.sh`, which `next-step` runs at Step 0 on a clean parent only. `git checkout -- .` and `git restore .` are always forbidden. (AISDLC-450)
7. **Never write GitHub Actions CI-skip magic tokens into commit messages (AISDLC-88).** GitHub parses `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]` case-insensitively and SUPPRESSES every workflow on a commit carrying one, silently disabling verify-attestation and ai-sdlc-review. Use the paren-quoted form `(skip ci marker)`; backtick-wrapping does NOT defeat the parser. `next-step` scrubs its own chore-commit body (`sanitizeCiSkipTokens`) and `.husky/pre-push` (`check-skip-ci-marker.sh`) is the backstop. The legacy CI attestor's `chore(ci): sign review attestation` commits (authored by `ai-sdlc-ci-attestor[bot]`, legacy `github-actions[bot]`) stay exempt; no new ones are produced (AISDLC-140, AISDLC-152).

Other floors that `next-step` enforces so you do not have to: the CCR remote-sandbox refusal (AISDLC-442, `AI_SDLC_SKIP_CCR_GUARD=1` for tests), a fail-closed hooks-directory check on the new worktree (AISDLC-693, install scripts are never disabled), the per-worktree `.active-task` sentinel (AISDLC-81, written at Step 4 and removed on every exit path), `permittedExternalPaths` sibling PRs, never auto-resolving a rebase conflict, and opening the PR as a DRAFT (AISDLC-218).

## Run

Resolve the pipeline CLI once (every later call uses the absolute `reply` command the CLI prints, so you never re-resolve), then make the first call. `--fresh` discards any stale state from an earlier run of the same argument.

```bash
PLUGIN_SCRIPTS_DIR="${CLAUDE_PLUGIN_DIR:-${CLAUDE_PLUGIN_ROOT:-$(pwd)/ai-sdlc-plugin}}/scripts"
if [ -z "${PIPELINE_CLI_BIN:-}" ]; then
  if [ -f "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh" ]; then
    PIPELINE_CLI_BIN=$(bash "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh") || { echo "ERROR: @ai-sdlc/pipeline-cli not found; export PIPELINE_CLI_BIN=/path/to/pipeline-cli/bin" >&2; exit 1; }
  else
    PIPELINE_CLI_BIN="$(pwd)/pipeline-cli/bin"
  fi
fi
STATE="${TMPDIR:-/tmp}/ai-sdlc-next-step/$(printf '%s' "$ARGUMENTS" | tr -c 'A-Za-z0-9.-' '_').json"
node "$PIPELINE_CLI_BIN/ai-sdlc-pipeline.mjs" next-step --task "$ARGUMENTS" --state "$STATE" --fresh
```

If it fails with an unknown-command error, the installed `@ai-sdlc/pipeline-cli` predates AISDLC-762: update the runtime (the resolver script prints how) and retry; do not fall back to improvising the pipeline by hand.

`next-step` prints exactly one JSON instruction on stdout (progress lines go to stderr; surface any `[ai-sdlc-progress]` lines to the user) and exits 0, or exits 1 for `stop`. Act on `action`:

### `spawn-developer`

Read `promptFile`. Spawn ONE `Agent` with `subagent_type: developer`, `prompt` = the file's contents verbatim, and `model` only if the instruction carries one. Its cwd is `cwd` (the worktree); the PreToolUse hook resolves `permittedExternalPaths` from the worktree's `.active-task`. Then report the agent's final message, unmodified: write it verbatim to a scratch file with the `Write` tool (never paste agent output into a shell command or heredoc), and run the instruction's `reply` command with its trailing `--result -` replaced by `--result <that file>`.

### `spawn-reviewers`

For EVERY entry of `reviewers`, spawn an `Agent` with `subagent_type` = `agent`, `prompt` = the contents of its `promptFile` verbatim (it already carries the diff-binding nonce marker; never edit or drop it), and `model` only if the entry has one. Issue ALL of them in a single message so they run in parallel, and note the `agentId` the Agent tool returns for each. Then report one JSON document shaped like `replyShape` (`agent`, that reviewer's `agentId`, `approved`, `findings[]` with `severity` of `critical|major|minor|suggestion`, `summary`), taken from each reviewer's own verdict, written to a scratch file and sent with the same `reply` command and `--result <file>`. Never invent or soften a verdict: a reviewer that returned no parseable verdict is reported `approved: false`. The CLI persists transcripts, emits the transcript leaves, aggregates, iterates (max 2 developer passes), rebases and re-reviews when needed, signs, pushes, opens the DRAFT PR and flips it ready.

### `fix-report`

Your last reviewer report could not be used (not JSON, or a reviewer's `agentId` was missing); `reason` says which. Nothing irreversible happened and the reviewers already ran: correct ONLY the report (use the `agentId` values the Agent tool returned) and send it again with the same `reply` command and `--result <file>`. Do NOT spawn the reviewers again. After two corrections the run stops.

### `done`

The PR exists. Print the summary below and stop. `outcome: needs-human-attention` means the 2-iteration cap was hit with unresolved findings: the PR is open as a draft, flagged for a human, and is NOT flipped ready.

### `stop`

Print `reason` (it names the next step: a worktree preserved at `worktreePath`, `/ai-sdlc cleanup <task-id>`, a rebase to resolve by hand, a missing signing key and `/ai-sdlc init-signing-key`, ...) and stop. Do not retry blindly, do not work around a refusal, and never resolve a rebase conflict yourself.

If you ever need the pending instruction again, run the same `reply` command as-is with `</dev/null` as its input: an empty result re-emits it. Orchestration budget: a normal run is 3-7 `next-step` calls plus the agents (AC-2 allows 15).

## Summary and return value

Print a tight summary (task, branch, worktree, developer commit and file count, review verdicts and iteration count, PR URL, sibling PR URLs, the retention note `Worktree retained for inspection; auto-removed on the next /ai-sdlc execute once the PR merges`), then print this JSON built from the final instruction. On `stop`, set `outcome` to its `outcome`, `prUrl` to `null`, and `notes` to its `reason`. Do not throw.

```json
{
  "taskId": "AISDLC-NN",
  "branch": "ai-sdlc/aisdlc-nn-...",
  "worktreePath": ".worktrees/aisdlc-nn",
  "outcome": "approved | needs-human-attention | developer-failed | developer-json-contract-violated | aborted",
  "developer": { "commitSha": "...", "filesChanged": ["..."], "verifications": { "build": "...", "test": "...", "lint": "...", "format": "..." }, "summary": "...", "notes": "..." },
  "reviews": { "iterations": 1, "harnessNote": "", "verdicts": [{ "agentId": "...", "harness": "claude-code|codex", "approved": true, "findings": { "critical": 0, "major": 0, "minor": 0, "suggestion": 0 } }] },
  "prUrl": "https://github.com/owner/repo/pull/N | null",
  "siblingPrUrls": ["..."],
  "notes": "anything the operator should know (optional)"
}
```

## Why this lives in the slash command body (not a subagent)

Plugin subagents cannot use the `Agent` tool (Claude Code filters it one level deep; AISDLC-69.2, AISDLC-98), so only the main session can spawn `developer` and the reviewers, which is the one thing this body still does. Parallelism is per Claude Code session: run `/loop /ai-sdlc execute <task-id>` or several terminals; each run has its own worktree, state file and `.active-task` sentinel, so nothing races.

## What this command DOES NOT do (intentional)

- **Never runs the raw merge command.** Merging follows `governance.allowMerge`; when it permits merging, the only path is `cli-merge-if-eligible`.
- **Never runs `git push --force`.** If a push fails, `next-step` stops and the operator decides.
- **Edits governance config (`.ai-sdlc/**`) only when the task names the file and the change** (AISDLC-720); `.github/workflows/**` is refused only when `blockedPaths` lists it.
- **Never auto-resolves rebase conflicts.** Step 10.5 stops with `rebase-conflict`; the operator owns conflict resolution.
- **Never spawns more than one developer pipeline per invocation.**

Maintainers: the step logic and its tests live in `pipeline-cli/src/next-step/{init,review-prepare,review-finalize,ship,next-step}.ts`; the CLI is `pipeline-cli/src/cli/next-step.ts`; see `pipeline-cli/README.md` ("next-step").
