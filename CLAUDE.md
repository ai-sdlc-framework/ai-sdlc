# AI-SDLC Project Instructions

## Git Flow

- **Always rebase** feature branches onto main; never merge main in.
- Update branch: `git fetch origin && git rebase origin/main`, then `git push --force-with-lease`.
- Never `gh api pulls/N/update-branch` with merge method. Keep linear history.
- `/ai-sdlc rebase <pr>` automates mechanical conflicts (CHANGELOG `Unreleased`, test additions to same `describe`, prettier drift) and re-signs the attestation only when `contentHash` changed. Escalates semantic conflicts, modify-vs-delete, verification failures, and 3-attempt iteration cap. Refuses force-push to `main`/`master`.

## CI marker hygiene

GitHub Actions silently skips ALL workflows when ANY commit body contains `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, or `[actions skip]` (substring, case-insensitive). Use the paren-quoted form `(skip ci marker)` in commit messages. Backtick-wrapping does NOT defeat the parser. `scripts/check-skip-ci-marker.sh` enforces on push.

## Branches & Commits

- Branches: `feat/<desc>`, `fix/<desc>`, or `ai-sdlc/issue-<n>`.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `style:`).
- Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.

## PRs

- **Never merge PRs** — only humans merge.
- **Never close** issues or PRs. **Never force-push to main/master.**
- Dismiss stale reviews only with documented reason (truncation, API errors).
- `auto-enable-auto-merge.yml` sets `--auto --rebase` on same-repo PRs (forks excluded; re-fires on synchronize/reopened). Setting `--auto` is NOT merging; GitHub merges once required checks pass.

## Testing

- Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before pushing.
- `.husky/pre-push` is the canonical gate; local pre-flight makes it a no-op.
- Hook scripts (`ai-sdlc-plugin/hooks/*.js`) use Node built-in `node --test`. Orchestrator + MCP server use Vitest.

## Hooks

`.husky/pre-push` chains in order:

1. **`scripts/check-coverage.sh`** — 80% lines coverage threshold per package. Skip: `AI_SDLC_SKIP_COVERAGE_GATE=1`.
2. **`scripts/check-attestation-sign.sh`** — auto-signs DSSE attestation when `<worktree>/.active-task` exists, `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` exists, and no envelope at HEAD. Commits the envelope as a separate `chore: auto-sign attestation for <task-id>` and exits 1 with "re-run git push". Idempotent on the second push (envelope-at-HEAD or HEAD-is-auto-sign-chore predicate). Skip: `AI_SDLC_SKIP_ATTESTATION_SIGN=1`.

`set -euo pipefail` aborts on first failure. `git push --no-verify` bypasses everything. Both gates have hermetic tests at `scripts/<name>.test.mjs` wired via `pnpm test:drift-gate` / `test:attestation-sign-gate`.

## CI behavior

PR merge gate is the single rollup check `ai-sdlc/pr-ready` produced by `.github/workflows/ai-sdlc-gate.yml` (re-actors/alls-green pattern); see [`docs/operations/quality-gate.md`](docs/operations/quality-gate.md) for archetype gating, cutover, and rollback.

Workflows MUST invoke pipeline-cli CLIs via `node pipeline-cli/bin/cli-XXX.mjs` directly — never via `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX`. `pnpm exec` does not resolve workspace own-bins, so the latter form silently fails with `Command not found` and any `|| echo <fallback>` safety net fires unconditionally. `pipeline-cli/src/cli/bin-invocation.test.ts` enforces both directions of this rule. See AISDLC-156 + the "Invoking from CI" section of `pipeline-cli/README.md`.

## Code Style

- TypeScript strict, ESM. Prettier + ESLint. No premature abstractions — three similar lines beat one wrong abstraction.

## Review attestations

**Attestation is audit-only.** `/ai-sdlc execute` runs three reviewer subagents locally and writes a DSSE envelope to `.ai-sdlc/attestations/<sha>.dsse.json` as a provenance record. CI's `verify-attestation.yml` validates the envelope and logs failures, but does NOT post a required-status check or block merge. The `re-actors/alls-green` aggregator (`ai-sdlc/pr-ready`) is the single merge gate; `ai-sdlc-review.yml`'s `Post Review Results` is the only review-tier required check. `contentHashV3` (sha256 of `{path, fileDeltaHash}` per changed file, base = `git merge-base(baseRef, headRef)`) is the rebase-stable content binding. Docs-only PRs (`spec/rfcs/**`, `docs/**`, `backlog/{tasks,completed}/**`, root `*.md`) skip both `ai-sdlc-review.yml` and `verify-attestation.yml` via `paths-ignore`; `ai-sdlc-review-docs-only.yml` posts the `Post Review Results` status directly so merge isn't deadlocked.

## Remote agents (`/schedule`) — read-only by design

CCR remote sandboxes have no signing key, no plugin install, no worktree, no operator filesystem. Treat them as read-only.

**Acceptable**: PR/backlog status surveys, cron metric digests, Slack workflows, CI run-list / flake detection.
**Prohibited**: `/ai-sdlc execute`, signing-key flows, plugin subagents (`developer`, `code-reviewer`, etc.), worktree ops, sibling-repo writes.

If a `/schedule` task needs real code work, have it file a backlog task or GitHub issue describing the work — a local Claude Code session picks it up.

## RFCs

Live in `spec/rfcs/RFC-NNNN-*.md`. Process: [`spec/rfcs/README.md`](spec/rfcs/README.md). Template: [`spec/rfcs/RFC-0001-template.md`](spec/rfcs/RFC-0001-template.md).

**Lifecycle field** (frontmatter, separate from sign-off checklist): `Draft` → `Ready for Review` → `Signed Off` → `Implemented`, or `Superseded`. Drafts land on main early — sign-off doesn't gate visibility. Legacy `status:` field retained for `scripts/check-rfc-docs.mjs`'s `requiresDocs` gate.

## Backlog Workflow

Tasks live in `backlog/tasks/` (open) and `backlog/completed/` (closed); managed via `mcp__backlog__*` MCP tools. Filename **must be ASCII**; titles may use unicode (`scripts/check-backlog-ascii.sh` enforces on commit).

### Drift gate

`backlog-drift` checks every reference in task frontmatter resolves. **Required** on commit (per-task pre-commit, fails on any drift in staged tasks) + CI (full repo, fails on `error`-severity issues only — `info`/`warning` are surfaced but non-blocking, AISDLC-125). Local-only escape: `AI_SDLC_SKIP_DRIFT_GATE=1` (pre-commit hook only — NOT honored in CI). Auto-fix: `npx backlog-drift fix --task AISDLC-N`.

### Canonical execution paths

| Use case | Command | Billing |
|---|---|---|
| Internal dogfood (backlog tasks) | `/ai-sdlc execute <task-id>` | Subscription (Claude Code Max) |
| Manual cleanup | `/ai-sdlc cleanup [<task-id>]` | n/a |
| GitHub issue / unattended / CI | `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` | API key |

`/ai-sdlc execute` is the default for internal work. Worktree-isolated, auto-creates sibling-repo PRs from `permittedExternalPaths`, marks Done + moves task file in the same PR.

The Step 0-13 pipeline lives in `pipeline-cli/` (`@ai-sdlc/pipeline-cli`). Tier 1 = slash command body (subscription). Tier 2 = `executePipeline()` library + `SubagentSpawner` injection (API-key, MockSpawner, etc.). Refs: `pipeline-cli/{README,docs/spawner,docs/steps}.md`, RFC-0012.

### Done semantics

- **`/ai-sdlc execute` path**: Done = "reviews-approved-and-PR-opened". Task file is moved to `backlog/completed/` BEFORE push.
- **Other paths**: Done = "merged". `.github/workflows/backlog-task-complete.yml` opens a follow-up PR after merge (idempotent — no-op if file is already in completed/).

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

- **Create-before-execution**: when a plan spans multiple tasks, create them ALL via `mcp__backlog__task_create` first.
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
<next steps or "(none)">
```

### When NOT to create a backlog task

- Inline fixes caught during review (use the PR).
- Trivial chores (deps, config, typos).
- Exploration/spikes (retroactively if it becomes real work).

## Releases

`.github/workflows/release.yml` runs `pnpm -r publish --no-git-checks` with no `--access` flag. Every non-`"private": true` workspace package MUST carry:

```jsonc
"publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" }
```

Without it, npm rejects with E402 silently per-package while the overall job appears green. `pnpm lint:publishable` (wired into `pnpm test`) catches regressions; the operator should also wire it as an explicit CI step in `.github/workflows/ci.yml`.

When adding a new publishable package: add to `pnpm-workspace.yaml`, add the `publishConfig` block (or mark `"private": true`), add to `release-please-config.json` if release-please should track its version. release-please does NOT add `publishConfig` automatically.

## Plugin MCP server — project root resolution (AISDLC-99)

The plugin's MCP server (`mcp__plugin_ai-sdlc_ai-sdlc__*` tools) resolves the project directory in this order: `AI_SDLC_PROJECT_ROOT` env → `CLAUDE_PROJECT_DIR` env → walk up from `process.cwd()` for an ancestor with `backlog/` → throw. Almost always falls through to the cwd-walk and finds the right project. Override with `AI_SDLC_PROJECT_ROOT=/abs/path` before launching Claude Code.
