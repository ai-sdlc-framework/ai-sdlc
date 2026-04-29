# AI-SDLC Project Instructions

## Git Flow

- **Always rebase** feature branches onto main. Never merge main into a feature branch.
- When updating a feature branch with latest main: `git fetch origin && git rebase origin/main`
- After rebase: `git push --force-with-lease origin <branch>`
- Never use `gh api pulls/N/update-branch` with merge method.
- Keep commit history linear — no merge commits on feature branches.

## Branch Naming

- Feature branches: `feat/<description>` or `ai-sdlc/issue-<number>`
- Fix branches: `fix/<description>`

## Commits

- Use conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `style:`
- Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` on all commits

## PRs

- **Never merge PRs** — only humans merge.
- **Never close issues or PRs.**
- **Never force push to main/master.**
- Dismiss stale reviews with a documented reason when they are false positives (truncated JSON, API errors).

## Testing

- Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before pushing.
- Hook scripts (`.js` in `ai-sdlc-plugin/hooks/`) are tested via Node built-in test runner (`.test.mjs`), not Vitest.
- MCP server and orchestrator use Vitest.

## Code Style

- TypeScript strict mode, ESM modules.
- Prettier for formatting, ESLint for linting.
- No unnecessary abstractions — three similar lines are better than a premature abstraction.

## Review attestations

`/ai-sdlc execute` runs three reviewer subagents (code/test/security) locally before pushing, then signs a DSSE attestation that CI verifies and trusts — skipping its own duplicate review run. Half of every clean run used to be duplicate review work; the attestation collapses it (AISDLC-74).

### Bootstrap (one time per machine)

1. `/ai-sdlc init-signing-key` — generates `~/.ai-sdlc/signing-key.pem` (ed25519, mode 0600) and prints a YAML block.
2. Open a PR adding that YAML block to `.ai-sdlc/trusted-reviewers.yaml`. A maintainer reviews + merges (just like any policy change).
3. After merge, `/ai-sdlc execute` will produce attestations CI accepts.

If `/ai-sdlc execute` errors with `signing-key not found`, run step 1 + open the onboarding PR first. Until the PR merges, attestations still get signed but CI marks them invalid (`signature did not match any trusted reviewer pubkey`) and runs its own review.

### File convention

- `~/.ai-sdlc/signing-key.pem` — private key (mode 0600, never committed, never leaves your machine)
- `.ai-sdlc/trusted-reviewers.yaml` — pubkey allowlist (committed, reviewed)
- `.ai-sdlc/attestations/<commit-sha>.dsse.json` — per-commit signed envelopes (committed, ~1-2KB each, audit trail)
- `.ai-sdlc/schemas/attestation.v1.schema.json` — JSON schema (current allowlist: `['v1']`)

### CI behavior

- `verify-attestation.yml` runs on `pull_request`. It scans every `.ai-sdlc/attestations/*.dsse.json` on the PR branch and matches by recomputing the predicate's content bindings (diff hash, policy hash, agent file hashes, plugin version, schema version) against current PR state — so the verifier is rebase-stable (AISDLC-84). It sets the `ai-sdlc/attestation` commit status to `valid` or `invalid (<reason>)`.
- `ai-sdlc-review.yml` Post Review Results checks that status. When `valid`, it short-circuits cleanly with a notice. Otherwise, it runs the duplicate review normally.
- When the attestation is missing or invalid, `verify-attestation.yml` ALSO posts a friendly educational PR comment (idempotent — checked via `<!-- ai-sdlc:attestation-fallback-comment -->` marker before posting again). The comment explains the bootstrap flow and the most common failure causes (force-push diff change, policy edit, missing trusted-reviewers entry).

### What CI rejects (intentional)

- Force-push that changes the diff after signing → `diffHash mismatch`
- Edit to `.ai-sdlc/review-policy.md` after signing → `policyHash mismatch`
- Edit to `ai-sdlc-plugin/agents/*.md` after signing → `agentFileHashes[<name>] mismatch`
- `schemaVersion` outside the current allowlist → `schemaVersion 'vN' not in allowlist [v1]`
- `pluginVersion` drift between the attestation and `ai-sdlc-plugin/plugin.json` → `pluginVersion mismatch`
- Signature from a private key whose pubkey isn't in `.ai-sdlc/trusted-reviewers.yaml` → `signature did not match any trusted reviewer pubkey`
- Copy-pasted attestation from another PR with different reviewed content → `diffHash mismatch`

All rejections are by design (threat model). Re-run `/ai-sdlc execute` against the current head to produce a fresh attestation.

### What CI accepts (intentional, post-AISDLC-84)

- Rebase, amend, or force-push that doesn't change reviewed content → still valid (filename SHA is informational only; matching is by predicate content). This was the day-one breakage AISDLC-84 fixed: every PR-merge cycle ate a duplicate review run because rebasing PR-N onto main rewrote the SHA on disk and the verifier couldn't find a match. The verifier now accepts as long as `diffHash + policyHash + agentFileHashes + pluginVersion + schemaVersion` all still resolve to the current PR state.

## Remote agents (`/schedule`) — read-only by design

Anthropic CCR remote-agent runs (scheduled via the bundled `/schedule` skill, `Path: bundled:schedule`) execute on Anthropic infrastructure with a fresh, ephemeral filesystem and **no access to the operator's machine**. They MUST be treated as read-only.

**Empirical justification.** Four consecutive `/ai-sdlc execute` runs scheduled via `/schedule` failed identically (overnight: AISDLC-78 / -79 / -80; morning: AISDLC-85). Root cause is structural, not flaky: the remote sandbox has no signing key, doesn't auto-install the `ai-sdlc-plugin/`, and can't register the plugin's subagents — so Step 1 (worktree bootstrap) and Steps 5-10 (developer + reviewers + DSSE attestation) of the execute pipeline cannot run. The medium-term fix is **AISDLC-87 (CI-side attestor)**, which moves attestation signing into a trusted CI workflow and unblocks remote-agent `/ai-sdlc execute` runs. Until AISDLC-87 ships, the policy below is hard.

### Acceptable remote-agent task patterns (read-only)

- **PR status surveys** — `gh pr list`, `gh pr view`, summarising open reviews, flagging stale PRs.
- **Backlog state reports** — `mcp__backlog__task_list`, surfacing `In Progress` / blocked / overdue tasks.
- **Cron-triggered metric digests** — review-throughput counts, attestation valid/invalid ratios, dogfood-loop health.
- **Slack workflows** — morning check-ins, end-of-day summaries, on-call digests posted to a visibility channel.
- **CI / workflow status surveys** — `gh run list`, recent failures, flake detection across the last N runs.

All of the above only need `gh` / MCP read tools and the network — no signing key, no plugin, no worktree.

### Explicitly prohibited remote-agent patterns

- **`/ai-sdlc execute <task-id>`** — will fail at Step 1 (no plugin loaded) or Step 9 (no signing key).
- **Any signing-key-dependent flow** — `/ai-sdlc init-signing-key`, signing fresh DSSE attestations, anything that touches `~/.ai-sdlc/signing-key.pem`.
- **Any plugin-subagent-dependent flow** — `developer`, `code-reviewer`, `test-reviewer`, `security-reviewer`, `execute-orchestrator` subagents are not registered in the remote sandbox.
- **Any flow that opens a worktree** — `/ai-sdlc execute`, `/ai-sdlc cleanup`, anything touching `.worktrees/`.
- **Any cross-repo write flow** — sibling-repo PRs (`permittedExternalPaths`) require local checkouts of those repos.

If a `/schedule`-triggered task needs to do real code work, the correct pattern today is: have the remote agent *file a backlog task or GitHub issue describing the work*, then a human (or local Claude Code session) picks it up and runs `/ai-sdlc execute` against it.

## Backlog Workflow

Backlog tasks live in `backlog/tasks/` (Backlog.md) and are managed via the `mcp__backlog__*` MCP tools. Every issue executed under the AI-SDLC pipeline MUST be tracked here.

### Canonical execution paths

| Use case | Command | Billing | Notes |
|---|---|---|---|
| **Internal dogfood (backlog tasks)** | `/ai-sdlc execute <task-id>` (slash command) | Subscription (Claude Code Max) | Runs as Claude Code subagents. Worktree-isolated. Auto-creates sibling-repo PRs from `permittedExternalPaths`. Marks Done + moves file in the same PR. |
| **Manual ad-hoc cleanup** | `/ai-sdlc cleanup [<task-id>]` | n/a | Sweeps merged worktrees from `.worktrees/` (no args) or force-removes one (with task-id). Never deletes branches automatically. |
| **GitHub-issue / unattended / CI** | `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` | API key | Orchestrator-driven (TypeScript service). Use this when a Claude Code session isn't available — webhooks, cron, contributor-PR workflow. |

For any internal task, default to `/ai-sdlc execute`. The orchestrator-driven path is reserved for unattended/programmatic use.

### Done semantics — `/ai-sdlc execute` vs other paths

- **`/ai-sdlc execute` path**: Done = "reviews-approved-and-PR-opened". The command marks Done + runs `task_complete` (moving the file to `backlog/completed/`) BEFORE pushing the PR, so the entire task lifecycle lands atomically in one PR. No follow-up workflow needed.
- **Other paths (orchestrator, manual, external contributors)**: Done = "merged". The `.github/workflows/backlog-task-complete.yml` workflow opens a follow-up PR after merge to flip status and move the file. The workflow is idempotent — when the file is already in `backlog/completed/` (because `/ai-sdlc execute` already moved it), the workflow short-circuits to a no-op.

### Cross-repo writes — `permittedExternalPaths`

Tasks that legitimately need to write into sibling git repos (e.g. AISDLC-68 writing into `../ai-sdlc-io/`) declare an allowlist in their frontmatter:

```yaml
---
id: AISDLC-68
title: ...
permittedExternalPaths:
  - '../ai-sdlc-io/'
---
```

The PreToolUse hook reads this via a per-worktree sentinel `<worktree>/.active-task` (written by `/ai-sdlc execute` Step 4). Without the allowlist, writes outside the worktree are denied. With the allowlist, the developer subagent may write to the listed paths but does NOT commit there itself — `/ai-sdlc execute` Step 12 creates parallel PRs in the sibling repos. The env var `AI_SDLC_ACTIVE_TASK_ID` remains a fallback for tests / external tooling.

**Parallel runs are first-class.** Multiple `/ai-sdlc execute` invocations can run concurrently against the same project root, including with cross-repo writes. The Step 0-13 pipeline lives inside the `execute-orchestrator` subagent (AISDLC-82) — the only plugin agent permitted to spawn nested subagents (`Task` tool). The slash command body is a thin wrapper that fires one `Task(execute-orchestrator)` call, so the main Claude Code session can fan out N orchestrators in parallel from a single message. Each orchestrator drives its own developer + 3 reviewer subagents against its own worktree, with its own per-worktree `.active-task` sentinel (AISDLC-81) — no shared project-level state to race on.

Scaling notes:
- N parallel runs ⇒ up to **3N concurrent reviewer subagents** (each orchestrator spawns 3 reviewers in parallel at Step 7). Reviewers are read-only so file-system contention is fine.
- The husky `pre-push` hook in `.husky/pre-push` serialises across orchestrators only at the push boundary (Step 11). Steps 5-10 (developer + reviews + attestation) run fully in parallel across orchestrators.
- `/loop /ai-sdlc:execute <task-id>` continues to work — `/loop` fires one Task at a time, which composes naturally with the orchestrator-subagent design.

The legacy project-level `.worktrees/.active-task` sentinel from earlier versions still works as a fallback for one release but is no longer written by `/ai-sdlc execute`.

### Lifecycle rules

- **Create before execution.** When a plan includes multiple issues (e.g. an RFC implementation), create ALL backlog tasks BEFORE starting work on any of them. Use `mcp__backlog__task_create` with `milestone` + `labels` + acceptance criteria.
- **Claim on start.** Flip status to `In Progress` via `mcp__backlog__task_edit` the moment you begin coding a task. (Handled automatically by `/ai-sdlc execute`.) Don't stack multiple tasks in progress unless they're actually being worked in parallel.
- **Complete — two steps, both required:**
  1. `mcp__backlog__task_edit` with `status: 'Done'`, `acceptanceCriteriaCheck: [1, 2, ...]`, and `finalSummary` documenting changes / design decisions / verification / follow-up.
  2. `mcp__backlog__task_complete` to **physically move the file from `backlog/tasks/` to `backlog/completed/`**. `task_edit` alone only flips the status field — the file stays in `tasks/` until `task_complete` archives it. A task isn't actually closed in the repo until it's in `backlog/completed/`.

  When using `/ai-sdlc execute`, both steps run automatically after reviews approve. When using other paths, run them yourself OR rely on the `backlog-task-complete.yml` post-merge workflow.
- **Never leave "To Do" after implementation.** If you finish work on AISDLC-N, AISDLC-N must be in `backlog/completed/` before (or atomically with) the PR merge. Retroactive close-out is acceptable, blank close-out is not.

### `finalSummary` template

```markdown
## Summary
<one-paragraph description of what shipped>

## Changes
- `path/to/file.ts` (new|modified): <what changed and why>
- ...

## Design decisions
- **<Decision>**: <reason>. <tradeoff or context>.
- ...

## Verification
- `pnpm build` — clean
- `pnpm vitest run <test-file>` — N/N pass
- `pnpm test` (full workspace) — <counts>, no regressions
- `pnpm lint` — clean

## Follow-up
<what unblocks next, what to do in a future PR, or "closes milestone M-N">
```

### When NOT to create a backlog task

- Inline fixes caught during review (use the PR itself).
- Trivial chores — dependency bumps, config tweaks, typo fixes.
- Exploration / spikes — if it becomes real work, retroactively create a task.

### Status-value conventions

- Backlog task statuses: `Draft`, `To Do`, `In Progress`, `Done`. Use `Draft` for tasks that aren't ready to execute (missing AC, blocked on decisions) and `To Do` for ready work.
- Task IDs: `AISDLC-<N>` is the standard prefix for project work. Sub-project task IDs (e.g. external contrib) follow their own conventions.

### Verification before closing

Run the full workspace test suite and lint BEFORE flipping to `Done`:

```bash
pnpm build && pnpm test && pnpm lint
```

Cite the counts in `finalSummary`. If you can't reproduce the counts in the task description, the task isn't done.

### Close-out checklist (end of task)

```
□ mcp__backlog__task_edit     → status: Done, acceptanceCriteriaCheck, finalSummary
□ mcp__backlog__task_complete  → moves file from tasks/ → completed/
□ verify with mcp__backlog__task_list (status: Done) that the task appears in the Done list
```

The file location is the source of truth: `backlog/tasks/<id>-*.md` = open, `backlog/completed/<id>-*.md` = closed. `task_edit` sets the status field inside the file but does NOT move it; `task_complete` does both.
