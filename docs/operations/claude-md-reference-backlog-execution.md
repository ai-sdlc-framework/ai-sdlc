# CLAUDE.md reference: backlog workflow and execution paths

This page holds the detailed text moved out of `CLAUDE.md` (AISDLC-742) to cut the per-call context floor. The operative rules stay in `CLAUDE.md`; the explanation, incident history and implementation detail live here, essentially verbatim. Section headings below are the original `CLAUDE.md` headings.

## Backlog Workflow

Tasks live in `backlog/tasks/` (open) and `backlog/completed/` (closed); managed via `mcp__backlog__*` MCP tools. Filename **must be ASCII**; titles may use unicode (`scripts/check-backlog-ascii.sh` enforces on commit).

### Non-dispatchable tasks (`dispatchable: false`) — AISDLC-243

Tasks that are **never** meant to be picked up by the autonomous orchestrator's developer subagent (soak phases, operator-only monitoring steps, investigation/diagnosis tasks) should carry `dispatchable: false` in their frontmatter. This prevents the orchestrator from wasting subscription time dispatching a subagent for work that requires human judgment.

```yaml
dispatchable: false                          # required to opt out of dispatch
dispatchableReason: "Operator soak phase — no code work; operator monitors stability"  # optional advisory
```

- **Default is `true`** — omitting the field means the task IS dispatchable (backward-compatible).
- **`blocked.reason`** is for temporary holds (awaiting external signal, soak windows that may eventually need code follow-up). Use `dispatchable: false` for tasks that are **permanently** not LLM-dispatchable.
- The `Dispatchability` filter runs AFTER `DependencyReadiness` and BEFORE `DorReadiness` in the orchestrator's admission chain, so non-dispatchable tasks skip the DoR log scan entirely.
- `cli-deps frontier --format table` annotates non-dispatchable frontier entries with `[non-dispatchable]` so operators can see the full frontier at a glance.
- Events: `OrchestratorBlockedByDispatchability` is emitted per-tick per-rejected-candidate to events.jsonl.

### Drift gate

`backlog-drift` checks every reference in task frontmatter resolves. **Required** on commit (per-task pre-commit, fails on any drift in staged tasks) + CI (full repo, fails on `error`-severity issues only — `info`/`warning` are surfaced but non-blocking, AISDLC-125). Local-only escape: `AI_SDLC_SKIP_DRIFT_GATE=1` (pre-commit hook only — NOT honored in CI). Auto-fix: `npx backlog-drift fix --task AISDLC-N`.

### Upstream-OQ gate (AISDLC-296 / RFC-0011 extension)

`refineBacklogTask()` (the DoR ingress shim) now runs an **upstream-OQ gate** before the seven-point rubric. The gate checks every RFC referenced by the task (via `references:` frontmatter or bare `RFC-NNNN` in body) and **rejects the task** when:

- The RFC's `lifecycle:` field is `Draft` or `Ready for Review` (not `Signed Off` or `Implemented`), OR
- The RFC's `## Open Questions` section contains at least one unresolved entry (no `**Resolution:**` / `RESOLVED:` / `✅ RESOLVED` marker).

**Rejection** emits a `DorRejectedByOpenUpstreamOqEvent` and is included in `shouldRefuseExecution` when `evaluationMode === 'enforce'`.

**Manual override**: tasks with `blocked.reason` in their frontmatter skip the gate — the operator has explicitly acknowledged the OQ status:

```yaml
blocked:
  reason: "RFC-0024 OQs acknowledged; operator walkthrough scheduled for 2026-05-20"
```

This prevents retroactive blocking of in-flight tasks and allows a graceful migration path. The override is logged to the calibration log.

**Code surface**: `pipeline-cli/src/dor/upstream-oq-gate.ts` — `checkUpstreamOqs()` is the entry point. All helpers (`extractRfcLifecycle`, `extractBlockedReason`, `findUnresolvedOqs`, `resolveRfcFilePath`) are exported for unit testing and reuse. `RefineBacklogTaskResult.upstreamOqCheck` exposes the full check result to callers.

### DoR ingress workflow gate (AISDLC-379)

`.github/workflows/dor-ingress.yml`'s `evaluate-pr-tasks` job **fails the `Evaluate backlog tasks changed by PR` status check** when any PR-staged backlog task has `overallVerdict: 'needs-clarification'` AND no `blocked.reason` override in frontmatter. Pre-AISDLC-379 the workflow posted the violations comment and then exited 0, so the check returned SUCCESS and auto-merge armed against PRs with unresolved Gate-3 violations (the 2026-05-20 RFC-0041 task-breakdown incident).

The decision is computed by `pipeline-cli dor-pr-has-violations`, which consumes the same JSONL the renderer reads and applies the same `extractBlockedReason()` parser as the upstream-OQ gate — one source of truth for what "violation with no override" means. The `Fail check on unresolved violations` step exits 1 with `::error::` annotations that surface in the PR Files-changed UI.

**Operator override mirrors the upstream-OQ gate**: tasks with `blocked.reason` in frontmatter bypass the workflow gate (the comment still posts as a `(override applied)` note). Use sparingly — every override is logged to the calibration log.

**Branch-protection helper**: `scripts/sync-dor-branch-protection.sh` PATCHes the canonical required-checks list (idempotent). Edit `REQUIRED_CONTEXTS` at the top of the script to add / remove a context, then re-run. Full runbook at [`docs/operations/dor-ingress-gate.md`](dor-ingress-gate.md).

**Code surface**: `pipeline-cli/src/dor/pr-violations.ts` (`computePrViolations()`), the `dor-pr-has-violations` subcommand in `pipeline-cli/src/cli/index.ts`, and the `Compute has_violations` + `Fail check on unresolved violations` steps in `.github/workflows/dor-ingress.yml`. Hermetic tests: `pipeline-cli/src/dor/pr-violations.test.ts` + `.github/workflows/__tests__/dor-ingress.test.mjs`.

### Canonical execution paths

| Use case | Command | Billing |
|---|---|---|
| Internal dogfood (backlog tasks) | `/ai-sdlc execute <task-id>` (e.g. `AISDLC-393`) | Subscription (Claude Code Max) |
| Internal dogfood (GitHub issues, subscription billing) | `/ai-sdlc execute <issue-number>` (e.g. `612`, `#612`, `gh:612`) | Subscription (Agent SDK credit pool post-2026-06-15; refuses to fall back to API key) — AISDLC-393 |
| **Autonomous loop — single-session drain (Pattern X v2, AISDLC-396)** | `/ai-sdlc orchestrator-tick` (once, ScheduleWakeup loops). Conductor dispatches background `Agent(developer)` per manifest; dev follows its standard contract (commit → rebase → push → open DRAFT PR). Conductor's next tick **reconciles after-the-fact**: parses dev's return JSON into a verdict, fans out 3 reviewers, signs attestation, force-pushes the chore commit on top of the dev's branch, flips draft → ready. | Subscription interactive quota only — Sonnet for dev/code/test, Opus only for security. One operator-opened CC session suffices. |
| **Autonomous loop — N>4 parallel via sibling Workers (Pattern Z)** | `/ai-sdlc orchestrator-tick` + N sibling sessions running `/ai-sdlc dispatch-worker` | Subscription interactive quota only. Use when Pattern X's `inSessionAgentMaxSessions` (default 4) is insufficient for the backlog burst. |
| Operator-driven single-PR (task file + impl land together) | `cli-orchestrator tick --task-from-file <path>` (AISDLC-373) | Same as the configured `--spawner` (subscription on default `claude`) |
| Manual cleanup | `/ai-sdlc cleanup [<task-id>]` | n/a |
| Shell-driven autonomous tick (cron/daemon/sidecar; Pattern Y) | `cli-orchestrator tick --spawner claude` | Subscription (shells out to `claude -p`; draws Agent SDK credit pool post-2026-06-15). Use when no operator CC session is available. |
| GitHub issue / unattended / CI | `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` | API key |

`/ai-sdlc execute` is the default for internal work. Worktree-isolated, auto-creates sibling-repo PRs from `permittedExternalPaths`, marks Done + moves task file in the same PR.

**AISDLC-393 — argument forms.** `/ai-sdlc execute` accepts (in this precedence order): `gh:<n>` (explicit GH-issue), `<prefix>-<number>` (backlog task ID like `AISDLC-393`, including hierarchical sub-IDs like `AISDLC-100.5`), `<number>` / `#<number>` (bare/hash-prefixed numeric → GH-issue). The reference parser lives in `dogfood/src/dispatch-execute-arg.ts` (`parseExecuteArg`) with hermetic test coverage. On the GH-issue path, NO backlog task file is created — the issue is the source of truth and the PR closes it via `Closes #N`. The watcher path (`pnpm --filter @ai-sdlc/dogfood watch --issue <id>`) accepts the same argument forms via the same parser, preserved unchanged for API-key/unattended/CI use. **Dispatch wiring:** the GH-issue path uses `fetchGhIssueAsTaskSpec()` (`dogfood/src/dispatch-from-issue.ts`) to synthesise an in-memory `TaskSpec`, then dispatches via `executePipeline({ taskSpec, sourceKind: 'gh-issue', issueNumber })` — the same composite the backlog-task path uses, just with two knobs flipped. Step 1 skips `findTaskFile`; Step 4 skips the frontmatter patch (sentinel still written) and materialises a transient synthetic task file at `<worktree>/backlog/tasks/<id> - <slug>.md` when `permittedExternalPaths` is non-empty so the PreToolUse hook resolves the allowlist (round-2 AC-2 fix; Step 13 removes the synthetic before push); Step 10 skips the tasks→completed move (attestation envelope still signed + committed); Step 11 formats the PR title with `(closes #N)` and prepends `Closes #N` to the body so the issue auto-closes on merge. **Billing safety (round 2 FINDING 2 fix):** the gh-issue branch pre-flights `claude` on PATH and refuses dispatch if the CLI is missing — refuses to fall back to `ANTHROPIC_API_KEY`-based SDK dispatch (paid API tokens) without explicit operator opt-in via the watcher path. **Latency (round 2 FINDING 3 fix):** the gh-issue branch fetches the issue once, caches the synthesised spec to a `$TMPDIR/aisdlc-393-spec-<n>-$$.json` tmpfile cleaned up on EXIT/INT/TERM, and feeds both the shell-scope TASK_ID extraction and the dispatch `node -e` block from that cache — no second `gh issue view` round-trip.

**Spawner kinds for `cli-orchestrator tick --spawner <kind>`** (AISDLC-349, default changed AISDLC-352; legacy `claude-cli` removed AISDLC-377.6):
- `mock` — fixtures only; for plumbing tests. Billing: none.
- `api-key` — uses `ANTHROPIC_API_KEY` via the Claude Code SDK. Billing: API token (pay-as-you-go or Agent SDK credit pool post-2026-06-15).
- `claude` — **(DEFAULT since AISDLC-352)** shells out to `claude -p` via `child_process.spawn`. **Use this for autonomous tick from a shell** (cron/daemon/sidecar context where no slash command body is around). Billing: subscription (Agent SDK credit pool, $200/mo on Max-20x). AISDLC-349. **Warning**: if `ANTHROPIC_API_KEY` is also set in env and `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` is configured, a spawner error can silently fall through to paid API tokens — the CLI warns at tick start.
- `codex` — dispatches via Codex CLI bridge (`CODEX_SPAWN_AGENT_BIN`). Billing: Codex plan.
- `copilot` — dispatches via GitHub Copilot CLI bridge (`COPILOT_SPAWN_AGENT_BIN`). Resolver throws a clear configuration error before any pipeline mutation when the env var is unset — refuses to silently fall back to `ANTHROPIC_API_KEY` billing. Billing: GitHub Copilot subscription. AISDLC-429.2 + AISDLC-429.3. See [`docs/operations/copilot-spawner.md`](copilot-spawner.md).
- ~~`claude-cli`~~ — **removed in RFC-0041 Phase 3.3 (AISDLC-377.6)** after the AISDLC-377.4 deprecation-warning window. Was the `ClaudeCliInlineSpawner` inline-manifest path (AISDLC-198). For subscription-billed parallel autonomous drain, use the Dispatch Board model: `/ai-sdlc orchestrator-tick` (Conductor) + N `/ai-sdlc dispatch-worker` sessions (Workers). Migration breadcrumb: [`docs/operations/claude-cli-spawner-removed.md`](claude-cli-spawner-removed.md).

**New dispatch patterns (RFC-0041 Conductor/Worker Architecture)**:
- `in-session-agent` — each Worker is a separate operator-opened CC session running `/ai-sdlc dispatch-worker`; tasks are claimed from the Dispatch Board (`.ai-sdlc/dispatch/queue/`) via foreground `Agent` calls (no watchdog, subscription quota). **Recommended default for autonomous drain.** N sessions = N-wide parallelism at zero incremental cost.
- `claude-p-shell` — Workers are `env -u CLAUDECODE claude -p` subprocesses spawned by `cli-dispatch-supervisor`. Operator-controlled 30 min watchdog. Draws Agent SDK credit pool post-2026-06-15. For headless/CI contexts where no operator CC session is available.

The Step 0-13 pipeline lives in `pipeline-cli/` (`@ai-sdlc/pipeline-cli`). Tier 1 = slash command body (subscription). Tier 2 = `executePipeline()` library + `SubagentSpawner` injection (API-key, MockSpawner, etc.). Refs: `pipeline-cli/{README,docs/spawner,docs/steps}.md`, RFC-0012.

### Done semantics

All paths: task file is moved to `backlog/completed/` in the originating PR's own diff via the `scripts/check-task-moved.sh` pre-push hook (AISDLC-220). The hook detects `(AISDLC-N)` in any commit subject in the push range, invokes the AISDLC-203 atomic helper, and commits the move as a chore commit — so the lifecycle close lands atomically with the work commit in the same PR.

- **`/ai-sdlc execute` path**: the developer subagent moves the file to `backlog/completed/` BEFORE push. The hook detects the file is already in completed/ and no-ops (idempotent).
- **Ad-hoc / external contributor path**: if the file is still in `backlog/tasks/` at push time, the hook auto-moves it. Zero friction, zero learning curve.

### Cross-repo writes — `permittedExternalPaths`

Tasks needing sibling-repo writes (e.g. `../ai-sdlc-io/`) declare an allowlist:

```yaml
permittedExternalPaths:
  - '../ai-sdlc-io/'
```

The PreToolUse hook reads `<worktree>/.active-task` (per-worktree sentinel, AISDLC-81) to resolve which allowlist applies. Without the file, cross-repo writes are denied. The developer subagent writes; `/ai-sdlc execute` Step 12 creates the parallel sibling PRs. Env fallback: `AI_SDLC_ACTIVE_TASK_ID`.

### Parallel runs

Each `/ai-sdlc execute` runs in its own Claude Code session with its own per-worktree sentinel. Fan out via `/loop /ai-sdlc execute <task-id>` or multiple terminals — no shared mutable state to race on. Pre-push hook serializes only at push (Step 11); Steps 5-10 run fully in parallel across runs.

Plugin subagents cannot use the `Agent` tool (Claude Code filters it one level deep — verified via AISDLC-69.2 test). The pipeline therefore lives inline in the slash command body, not in a subagent middleman (AISDLC-82 reverted by AISDLC-98).

### Lifecycle rules

- **Create-before-execution**: when a plan spans multiple tasks, create them ALL before dispatching. In Pattern C projects (non-bare parent repo + `.worktrees/` isolates), use `mcp__plugin_ai-sdlc_ai-sdlc__task_create` — it routes writes to the active worktree so files survive the next `git reset --hard` on the parent. In plain (non-Pattern-C) projects `mcp__backlog__task_create` is fine.
- **Claim on start**: status → `In Progress` (auto by `/ai-sdlc execute`).
- **Complete = TWO steps**: `mcp__backlog__task_edit` (status, ACs, finalSummary) + `mcp__backlog__task_complete` (moves file). File location is source of truth. Run the workspace test suite + lint before flipping.
- **Never leave `To Do` after implementation.** A task isn't closed until it's in `backlog/completed/`.

### `finalSummary` template

```markdown
## Summary
<one-paragraph: what shipped>

## Changes
- `path/to/file.ts` (new|modified): <what + why>

## Design decisions
- **<Decision>**: <reason + tradeoff>

## Verification
- `pnpm build` — clean
- `pnpm test` — <counts>
- `pnpm lint` — clean

## Follow-up
<every item cites a task or issue id (e.g. AISDLC-123 or #123), or starts with "declined: <reason>"; or write "(none)">
```

### When NOT to create a backlog task

- Inline fixes caught during review (use the PR).
- Trivial chores (deps, config, typos).
- Exploration/spikes (retroactively if it becomes real work).

