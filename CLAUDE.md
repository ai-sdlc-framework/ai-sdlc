# AI-SDLC Project Instructions

**Scope:** AI-SDLC is a full autonomous SDLC framework — autonomous orchestrator (RFC-0015), cross-harness review (RFC-0010 §13), decision engine (RFC-0011 DoR), operator TUI (RFC-0023), Pattern-C worktree isolation, and declarative governance. The `ai-sdlc-plugin/` package is the Claude Code plugin pillar; `pipeline-cli/` is the Step 0-13 pipeline runtime; `orchestrator/` is the CLI and agent runner layer.

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
- `auto-enable-auto-merge.yml` sets `--auto` on same-repo PRs (no method flag — the merge-queue ruleset on `main` enforces its configured strategy and overrides any flag passed by the workflow). Currently the queue is SQUASH so PRs land as one commit on main; if the queue's strategy is ever flipped in repo settings, no workflow change is needed. Setting `--auto` is NOT merging. (Legacy `--rebase` workaround retired in AISDLC-221 — GitHub now serializes auto-merge through the queue strategy, so the old "method-must-differ" trap no longer reproduces.)

## Testing

- Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before pushing.
- `.husky/pre-push` is the canonical gate; local pre-flight makes it a no-op.
- Hook scripts (`ai-sdlc-plugin/hooks/*.js`) use Node built-in `node --test`. Orchestrator + MCP server use Vitest.

## Hooks

`.husky/pre-push` chains in order:

1. **`scripts/check-coverage.sh`** — 80% lines coverage threshold per package. Skip: `AI_SDLC_SKIP_COVERAGE_GATE=1`.
2. **`scripts/check-task-moved.sh`** — auto-moves backlog task file from `backlog/tasks/` to `backlog/completed/` when any commit in the push range has `(AISDLC-N)` in its subject and the file is still in tasks/. Invokes the AISDLC-203 atomic helper (`cli-task-complete`), stages the move, commits as `chore: auto-close AISDLC-N (AISDLC-220)`, and exits 1 with "re-run git push". Idempotent on the second push (file already in completed/ or HEAD is auto-close chore predicate). **Order is load-bearing — MUST run BEFORE attestation-sign (item 3):** attestation's contentHashV4 binds `{path, headBlobSha}` per file; if the task move happens after sign, the envelope hashes the old path while the PR diff contains the new path → verify-attestation rejects. Skip: `AI_SDLC_SKIP_TASK_MOVE=1`.
3. **`scripts/check-dor-gate.sh`** — runs `cli-dor-check --task <path>` against every `backlog/{tasks,completed}/*.md` file changed in the push range, forcing `evaluationMode: enforce` so violations BLOCK locally even when the repo's `dor-config.yaml` is `warn-only`. Catches gate-2 markers (TBD/XXX/TODO), gate-3 unresolved references, gate-7 invisible-dependency phrases, and upstream-OQ blocks. No-ops on fresh worktrees pre-build (bin/dist missing). Skip: `AI_SDLC_SKIP_DOR_GATE=1`. AISDLC-370.
4. **`scripts/check-attestation-sign.sh`** — auto-signs DSSE attestation when `<worktree>/.active-task` exists, `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` exists, and no envelope at HEAD. Commits the envelope as a separate `chore: auto-sign attestation for <task-id>` and exits 1 with "re-run git push". Idempotent on the second push (envelope-at-HEAD or HEAD-is-auto-sign-chore predicate). **Docs-only auto-approve (AISDLC-215):** when the verdict file is missing AND `scripts/is-docs-only-changeset.mjs` reports the changeset is docs-only, the hook synthesizes a transient auto-approved verdicts file (3 reviewer entries, gitignored) and proceeds to sign — no manual step required. Code PRs with a missing verdict file still exit 0 (no-op) as before. Skip: `AI_SDLC_SKIP_ATTESTATION_SIGN=1`.

**Master bypass (emergency only):** `AI_SDLC_BYPASS_ALL_GATES=1 git push` stops the entire pre-push chain at all 6 hooks (coverage, task-move, mcp-bundle-sync, squash-attestation-chores, dor-gate, attestation-sign). Each hook checks this var at the very top (after `set -euo pipefail`) and exits 0 immediately with a `[<hook>] AI_SDLC_BYPASS_ALL_GATES=1 — skipping` message to stderr. Use exclusively during RFC-0042 / gate-rewrite cutover windows; document every use in the PR body. Per-gate `AI_SDLC_SKIP_*` vars continue to work independently. See [`docs/operations/emergency-bypass.md`](docs/operations/emergency-bypass.md) for the full runbook.

`set -euo pipefail` aborts on first failure. `git push --no-verify` bypasses everything. All gates have hermetic tests at `scripts/<name>.test.mjs` wired via `pnpm test:drift-gate` / `test:task-move-gate` / `test:dor-gate` / `test:attestation-sign-gate`.

## CI behavior

PR merge gate is the single rollup check `ai-sdlc/pr-ready` produced by `.github/workflows/ai-sdlc-gate.yml` (re-actors/alls-green pattern); see [`docs/operations/quality-gate.md`](docs/operations/quality-gate.md) for archetype gating, cutover, and rollback.

Workflows MUST invoke pipeline-cli CLIs via `node pipeline-cli/bin/cli-XXX.mjs` directly — never via `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX`. `pnpm exec` does not resolve workspace own-bins, so the latter form silently fails with `Command not found` and any `|| echo <fallback>` safety net fires unconditionally. `pipeline-cli/src/cli/bin-invocation.test.ts` enforces both directions of this rule. See AISDLC-156 + the "Invoking from CI" section of `pipeline-cli/README.md`.

## Feature flags

- **`AI_SDLC_DEPS_COMPOSITION`** (RFC-0014): gates the dependency-graph composition layer. Off by default. Truthy values: `1`, `true`, `yes`, `on` (case-insensitive); anything else (including unset) is OFF. Phase 1 surface = `cli-deps snapshot` writes `$ARTIFACTS_DIR/_deps/snapshot.<iso>.<tag>.jsonl`; `cli-deps gc/inspect` operate on those files. See [`docs/operations/deps-composition.md`](docs/operations/deps-composition.md) and [`pipeline-cli/docs/deps.md`](pipeline-cli/docs/deps.md). Phases 2-4 (PPA composition, DoR blast-radius, Slack digest) ship behind the same flag. Phase 5 ships the corpus aggregator (`cli-deps-corpus aggregate`) + operator-override capture (`cli-deps log-override`) + the hybrid promotion runbook at [`docs/operations/deps-composition-promotion.md`](docs/operations/deps-composition-promotion.md) — operators dispatch the default-on flip from there once the corpus or spot-check evidence supports it.
- **`AI_SDLC_AUTONOMOUS_ORCHESTRATOR`** (RFC-0015): gates the autonomous pipeline orchestrator. Off by default. Canonical opt-in value: `experimental` (other truthy values `1`/`true`/`yes`/`on` accepted, case-insensitive). When unset the loop refuses to start. Phase 1 surface = `cli-orchestrator {start,tick,status}` (invoke directly via `node pipeline-cli/bin/cli-orchestrator.mjs`). Phases 2-5 (failure playbook, DoR/dep admission filters, `events.jsonl` writer, soak corpus + promotion) ship behind the same flag. Phase 5 ships the corpus aggregator (`cli-orchestrator-corpus aggregate`) + chaos-test harness (`pipeline-cli/src/orchestrator/chaos.test.ts`) + the hybrid promotion runbook at [`docs/operations/orchestrator-promotion.md`](docs/operations/orchestrator-promotion.md) — operators dispatch the default-on flip from there once the corpus or spot-check evidence supports it. See [`pipeline-cli/docs/orchestrator.md`](pipeline-cli/docs/orchestrator.md) and [`spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`](spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md).

## Code Style

- TypeScript strict, ESM. Prettier + ESLint. No premature abstractions — three similar lines beat one wrong abstraction.

## Subagent Governance — OQ-resolution prohibition (AISDLC-298)

**Dev subagents MUST NOT resolve RFC Open Questions inline during implementation.**

AISDLC-271 / RFC-0031 shipped with all 5 OQs resolved by the dev subagent during a single development iteration — framework-level architectural decisions made without operator walkthrough or cross-pillar review. This is explicitly prohibited.

### What counts as inline OQ resolution

Any addition of a `**Resolution:**` (or `RESOLVED:` / `✅ RESOLVED`) marker to an RFC `## Open Questions` section by a developer subagent during task implementation. This includes:

- Picking an implementation approach and writing the rationale directly into the RFC
- Removing or replacing an OQ bullet with a concluded design decision
- Writing code that implicitly resolves an OQ without documenting the escalation

### Required behavior: escalate, do not resolve

When a dev subagent encounters an open question that blocks or constrains implementation:

1. **Stop and escalate** — do not pick an approach and resolve the OQ inline
2. **Return `prUrl: null` with a `notes` field** explaining which OQ in which RFC is blocking and what options exist
3. **Do not write Resolution markers** into RFC bodies — that is exclusively the operator's role after a walkthrough

If an OQ is genuinely non-blocking (implementation can proceed without resolving it), proceed with a documented assumption in the PR body — not a Resolution marker in the RFC.

### Long-term replacement: RFC-0035 Decision Catalog

The long-term mechanism for OQ resolution is the [Decision Catalog (RFC-0035)](spec/rfcs/RFC-0035-decision-catalog-operator-routing.md). OQs in RFC bodies will eventually project into the catalog as `Decision` records, routed to the appropriate actor (Engineering / Product / Operator), resolved asynchronously with full audit trail. Until that ships, escalate by returning `prUrl: null` per the protocol above.

### Reviewer gate (AISDLC-298)

The `code-reviewer` and `test-reviewer` subagents check for inline OQ resolutions in every PR diff. A new `**Resolution:**` marker added by a developer in an RFC's `## Open Questions` section is a **critical** finding that blocks approval.

## Review attestations

**Attestation is required.** `/ai-sdlc execute` runs three reviewer subagents locally and writes a DSSE envelope to `.ai-sdlc/attestations/<sha>.dsse.json`. `verify-attestation.yml` posts `ai-sdlc/attestation: success/failure` (required status on `main` per AISDLC-193). Missing/invalid envelopes block merge. `ai-sdlc-review.yml`'s `Post Review Results` is the parallel review-tier required check (CI-side reviewers run when local attestation is missing as the cost-saver fallback). New envelopes carry BOTH `contentHashV3` (`sha256("<baseBlobSha> -> <headBlobSha>")` per changed file — partially rebase-stable, invalidates when sibling PRs touch the same files) AND `contentHashV4` (per-file `{path, headBlobSha}` JSON map, base-independent — survives merge-queue rebases when the PR's files don't overlap with sibling PRs; correctly rejects when a sibling PR modified the same files, because the reviewed content genuinely changed — operator must rebase + re-sign in that case, see `docs/operations/merge-queue-rebase-recovery.md`). The verifier prefers v5 when present, falls back to v4, then v3 for legacy envelopes. New envelopes carry ALL three hashes (v3+v4+v5) for maximum backward + forward compatibility, with `schemaVersion: 'v5'`. The file collector excludes the envelope file itself (`.ai-sdlc/attestations/<sha>.dsse.json`) so the chore-commit pattern (sign at dev → add envelope at chore → push) doesn't chicken-and-egg the hash. All collectors also exclude a fixed `CONTENTHASH_SHARED_CHURN_FILES` list (formerly `CONTENTHASHV4_IGNORE_FILES`, renamed AISDLC-362 with backward-compat alias) of shared-churn files (`pnpm-lock.yaml`, `CHANGELOG.md`, `pipeline-cli/CHANGELOG.md`, `orchestrator/CHANGELOG.md`, `reference/src/core/generated-schemas.ts`) that change in most PRs due to tooling automation — excluding them prevents the merge-queue rebase+re-sign loop when only these files differ (AISDLC-258, AISDLC-342). These files are excluded on BOTH the signer and verifier sides. DO NOT add source files, test files, configs, `package.json`, or RFCs to this list. `generated-schemas.ts` is the **only** sanctioned `.ts` source-file exception (AISDLC-342): it's regenerated from `spec/schemas/*.schema.json` on every `pnpm build` and carries zero human intent — the underlying schema JSON files remain in v5 so the reviewer signal is preserved. **v5 algorithm (AISDLC-362):** `computeContentHashV5(entries, signedMergeBase)` — SHA-256 of canonical JSON `{schemaVersion:'v5', signedMergeBase:'<sha>', files:[{path,blobSha}...]}`. `collectChangedFileEntriesForV5(repoRoot, baseRef, headRef)` — computes `git merge-base <baseRef> HEAD` ONCE at sign time (the FROZEN merge-base), then diffs `<signedMergeBase>..HEAD`. The verifier reproduces the diff using the frozen SHA from the predicate, not the moving `origin/main`. Non-overlapping sibling merges do not invalidate v5; overlapping (same file) sibling merges correctly invalidate it. Docs-only PRs (`spec/rfcs/**`, `docs/**`, `backlog/{tasks,completed}/**`, root `*.md`) bypass the full review+attestation pipeline: `paths-ignore` skips `ai-sdlc-review.yml` and `verify-attestation.yml` on `pull_request` events; on `merge_group` events (where `paths-ignore` does not apply), both workflows detect docs-only changesets inline via `scripts/is-docs-only-changeset.mjs` (AISDLC-206) and short-circuit with `success` statuses directly (AISDLC-214). The former fallback workflows (`ai-sdlc-review-docs-only.yml`, `verify-attestation-docs-only.yml`) have been retired — they caused CANCELLED races on the merge queue.

## Remote agents (`/schedule`) — read-only by design

CCR remote sandboxes have no signing key, no plugin install, no worktree, no operator filesystem. Treat them as read-only.

**Acceptable**: PR/backlog status surveys, cron metric digests, Slack workflows, CI run-list / flake detection.
**Prohibited**: `/ai-sdlc execute`, signing-key flows, plugin subagents (`developer`, `code-reviewer`, etc.), worktree ops, sibling-repo writes.

If a `/schedule` task needs real code work, have it file a backlog task or GitHub issue describing the work — a local Claude Code session picks it up.

## RFCs

Live in `spec/rfcs/RFC-NNNN-*.md`. Process: [`spec/rfcs/README.md`](spec/rfcs/README.md). Template: [`spec/rfcs/RFC-0001-template.md`](spec/rfcs/RFC-0001-template.md).

**Lifecycle field** (frontmatter, separate from sign-off checklist): `Draft` → `Ready for Review` → `Signed Off` → `Implemented`, or `Superseded`. Drafts land on main early — sign-off doesn't gate visibility. Legacy `status:` field retained for `scripts/check-rfc-docs.mjs`'s `requiresDocs` gate.

**Number lookup**: the canonical registry of every shipped, in-flight, withdrawn, and reserved RFC number is the [Registry](spec/rfcs/README.md#registry) table in `spec/rfcs/README.md` (AISDLC-165). To pick the next available number, read the "Next available number" line at the bottom of that table — do NOT scan the filesystem, the registry includes reservations that have no file yet.

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

### Canonical execution paths

| Use case | Command | Billing |
|---|---|---|
| Internal dogfood (backlog tasks) | `/ai-sdlc execute <task-id>` | Subscription (Claude Code Max) |
| **Autonomous loop — zero incremental cost post-2026-06-15** | `/ai-sdlc orchestrator-tick` (once, then ScheduleWakeup loops) | Subscription interactive quota only — Agent SDK credit NOT drawn. Requires active Claude Code session. See `docs/operations/billing-and-cost-optimization.md` §1b. |
| Manual cleanup | `/ai-sdlc cleanup [<task-id>]` | n/a |
| Shell-driven autonomous tick (cron/daemon/sidecar) | `cli-orchestrator tick --spawner claude` | Subscription (shells out to `claude -p`; draws Agent SDK credit pool post-2026-06-15) |
| GitHub issue / unattended / CI | `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` | API key |

`/ai-sdlc execute` is the default for internal work. Worktree-isolated, auto-creates sibling-repo PRs from `permittedExternalPaths`, marks Done + moves task file in the same PR.

**Spawner kinds for `cli-orchestrator tick --spawner <kind>`** (AISDLC-349, default changed AISDLC-352):
- `mock` — fixtures only; for plumbing tests. Billing: none.
- `api-key` — uses `ANTHROPIC_API_KEY` via the Claude Code SDK. Billing: API token (pay-as-you-go or Agent SDK credit pool post-2026-06-15).
- `claude-cli` — **DEPRECATED** (RFC-0041 Phase 3.1, removal in v0.11). Emits a `dispatch-manifest.json` for the calling slash command body to consume via the `Agent` tool. **Only works when called from inside a Claude Code session**; fails silently with `developer-json-contract-violated` from a plain shell. Races the Anthropic 600s background-agent watchdog (~85% kill rate on real tasks). Migrate to `in-session-agent` (Dispatch Board + `/ai-sdlc dispatch-worker`) — see `docs/operations/operator-runbook.md` §"Choosing a dispatch model". Suppressible: `AI_SDLC_SUPPRESS_DEPRECATION_WARNING=1`.
- `claude` — **(DEFAULT since AISDLC-352)** shells out to `claude -p` via `child_process.spawn`. **Use this for autonomous tick from a shell** (cron/daemon/sidecar context where no slash command body is around). Billing: subscription (Agent SDK credit pool, $200/mo on Max-20x). AISDLC-349. **Warning**: if `ANTHROPIC_API_KEY` is also set in env and `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` is configured, a spawner error can silently fall through to paid API tokens — the CLI warns at tick start.
- `codex` — dispatches via Codex CLI bridge (`CODEX_SPAWN_AGENT_BIN`). Billing: Codex plan.

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

## Plugin MCP server — project root resolution (AISDLC-99, AISDLC-216)

The plugin's MCP server (`mcp__plugin_ai-sdlc_ai-sdlc__*` tools) resolves the project directory in this order: `AI_SDLC_PROJECT_ROOT` env → `CLAUDE_PROJECT_DIR` env → walk up from `process.cwd()` for an ancestor with `backlog/` → throw. Almost always falls through to the cwd-walk and finds the right project. Override with `AI_SDLC_PROJECT_ROOT=/abs/path` before launching Claude Code.

### Pattern C routing (AISDLC-216)

In Pattern C (non-bare parent repo + `.worktrees/<task-id>/` isolates), the parent's working tree is **read-only**. The MCP server starts from the parent's cwd and `process.cwd()` resolves to the parent root — without extra routing, writes would accumulate as untracked debris in the parent rather than landing in the correct worktree.

After resolving the candidate root, the resolver checks for Pattern C: if `<root>/.worktrees/` exists and contains at least one subdirectory, the root is a Pattern C parent and the following routing applies:

1. **`AI_SDLC_ACTIVE_TASK_ID` env var** — if set, routes to `<parent>/.worktrees/<task-id-lower>/`
2. **Per-worktree `.active-task` sentinels** — scans `<parent>/.worktrees/<id>/.active-task` (matches `pipeline-cli/src/steps/04-flip-status.ts` write location and `findWorktreeSentinel` pattern). When multiple worktrees have sentinels (parallel runs), the most-recently-modified one wins.
3. **No signal → refuse** with the Pattern C error message.

The typical Pattern C setup: `/ai-sdlc execute <task-id>` automatically writes `.worktrees/<task-id>/.active-task` (per AISDLC-81). For sessions where the env-var path is preferred (e.g. operator manually launching Claude Code into a multi-worktree project), set `AI_SDLC_ACTIVE_TASK_ID=AISDLC-NNN` before launch.

### Pattern C hard guards (AISDLC-358)

The parent working tree MUST be on `main` at all times. This is enforced by `scripts/check-orchestrator-state.sh` (called at Step 0 of every `/ai-sdlc execute` and `/ai-sdlc orchestrator-tick`) and by the inline `runParentBranchGuard()` check at the top of every `runOrchestratorTick()` call in `pipeline-cli/src/orchestrator/loop.ts`.

Guard logic (two outcomes):

- **Parent on non-main branch, clean working tree** → auto-recover: `git checkout main && git reset --hard origin/main`. Logs `[orchestrator-state] auto-recovered parent from '<branch>' to main`.
- **Parent on non-main branch, dirty working tree** → REFUSE. Prints the offending branch name, the dirty paths, and the manual recovery command. Exits non-zero (`check-orchestrator-state.sh`) or throws `ParentNotOnMainError` (TypeScript loop). The orchestrator tick is aborted; no frontier work proceeds.

Recovery (operator): stash or commit your changes in the parent, then run `git checkout main && git reset --hard origin/main`.
