# AI-SDLC Project Instructions

**Scope:** AI-SDLC is a full autonomous SDLC framework — autonomous orchestrator (RFC-0015), cross-harness review (RFC-0010 §13), decision engine (RFC-0011 DoR), operator TUI (RFC-0023), Pattern-C worktree isolation, and declarative governance. The `ai-sdlc-plugin/` package is the Claude Code plugin pillar; `pipeline-cli/` is the Step 0-13 pipeline runtime; `orchestrator/` is the CLI and agent runner layer.

## Git Flow

- **Always rebase** feature branches onto main; never merge main in.
- Update branch: `git fetch origin && git rebase origin/main`, then `git push --force-with-lease`.
- Never `gh api pulls/N/update-branch` with merge method. Keep linear history.
- `/ai-sdlc rebase <pr>` automates mechanical conflicts (test additions to same `describe`, prettier drift) and re-signs the attestation only when `contentHash` changed. Escalates semantic conflicts, modify-vs-delete, verification failures, and 3-attempt iteration cap. Refuses force-push to `main`/`master`. **CHANGELOG.md conflicts should not arise on feature branches** — if a rebase surfaces one, remove the CHANGELOG change from the feature branch rather than merging both sides (AISDLC-401).

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
- `auto-enable-auto-merge.yml` sets `--auto --squash` on same-repo PRs (AISDLC-400: merge queue dropped 2026-05-23; explicit `--squash` ensures PRs always land as one commit on main regardless of repo-default drift). Setting `--auto` is NOT merging. PRs merge directly once `ai-sdlc/pr-ready` + `Backlog Drift` required checks pass — no merge-queue serialization, no update-branch CI re-run. AISDLC-398's content-addressed envelopes (headBlobSha-based, base-independent) eliminate v4-kick permanently. See `docs/operations/merge-without-queue.md` for the full flow and rollback procedure.

## Testing

- Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before pushing.
- `.husky/pre-push` is the canonical gate; local pre-flight makes it a no-op.
- Hook scripts (`ai-sdlc-plugin/hooks/*.js`) use Node built-in `node --test`. Orchestrator + MCP server use Vitest.
- `@ai-sdlc/dogfood` tests (`dogfood/src/runner/exports.test.ts`) import from `dist/runner/index.js` to validate the built exports surface. The `pretest` lifecycle hook in `dogfood/package.json` runs `pnpm build` automatically before `pnpm test`, so `pnpm --filter @ai-sdlc/dogfood test` always works. Do NOT remove the `pretest` hook — it prevents CI failures on PRs where dogfood is selected by the `...[origin/main]` test filter but dist wasn't explicitly built (AISDLC-404).

## Hooks

`.husky/pre-push` chains in order:

1. **`scripts/check-coverage.sh`** — 80% lines coverage threshold per package. Skip: `AI_SDLC_SKIP_COVERAGE_GATE=1`.
2. **`scripts/squash-attestation-chores.sh`** — squashes stacked `chore: sign attestation` commits at HEAD into one to keep history clean. Must run before attestation-sign. No-op when 0 or 1 such commits. Skip: `AI_SDLC_SKIP_SQUASH_CHORES=1`.
3. **`scripts/check-dor-gate.sh`** — runs `cli-dor-check --task <path>` against every `backlog/{tasks,completed}/*.md` file changed in the push range, forcing `evaluationMode: enforce` so violations BLOCK locally even when the repo's `dor-config.yaml` is `warn-only`. Catches gate-2 markers (TBD/XXX/TODO), gate-3 unresolved references, gate-7 invisible-dependency phrases, and upstream-OQ blocks. **Conditional fresh-worktree behavior (AISDLC-378):** when `pipeline-cli/dist/cli/dor-check.js` is missing AND the push touches backlog task files, FAILS LOUD with a build instruction (`pnpm --filter @ai-sdlc/pipeline-cli build`) — silently skipping here is what allowed the 2026-05-20 incident to ship 5 violating task files past the gate. When the push has NO task changes and dist is missing, still silently exits 0 so fresh-worktree pushes of unrelated code aren't blocked. Skip: `AI_SDLC_SKIP_DOR_GATE=1`. AISDLC-370.
4. **`scripts/pre-push-fixups.sh`** (AISDLC-386) — orchestrates two mechanical fixup sub-hooks in dependency order (task-move → attestation-sign) in a single pass. (mcp-bundle-sync removed by AISDLC-385 — bundle now distributed via npm.) Each sub-hook is invoked with `AI_SDLC_INTERNAL_NO_EXIT_1=1` so it does its work but exits 0 instead of 1. After all sub-hooks complete, if any fixup ran, the orchestrator exits 1 ONCE with a consolidated "re-run git push" message. This collapses the worst-case 3-push chain into 2. Exit 0 silently when no fixups are needed.
5. **`scripts/check-task-moved.sh`** (defense-in-depth) — auto-moves backlog task file from `backlog/tasks/` to `backlog/completed/` when any commit in the push range has `(AISDLC-N)` in its subject. Commits as `chore: auto-close AISDLC-N (AISDLC-220)`. **Silent skip when file is already git-tracked in `backlog/completed/`** (AISDLC-402): uses `git ls-files` to check tracked state; when the dev subagent already moved the file (the `/ai-sdlc execute` path), exits 0 with zero log noise and zero chore commits, eliminating the double-push for 95%+ of PRs. On the re-push after the orchestrator ran, this is an idempotent no-op. **Order is load-bearing — MUST run BEFORE attestation-sign:** attestation's contentHashV4 binds `{path, headBlobSha}` per file; task move must happen before sign. Skip: `AI_SDLC_SKIP_TASK_MOVE=1`.
6. **`scripts/check-attestation-sign.sh`** (defense-in-depth) — auto-signs DSSE attestation when `<worktree>/.active-task` exists, `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` exists, and no envelope at HEAD. On the re-push after the orchestrator ran, this is an idempotent no-op. When no verdict file exists (docs-only PRs, chore commits, ad-hoc pushes), exits 0 as a no-op — docs-only PRs skip `verify-attestation.yml` entirely via `paths-ignore` (AISDLC-388) and do not require an attestation status posted (AISDLC-214 + AISDLC-387 + AISDLC-388). Skip: `AI_SDLC_SKIP_ATTESTATION_SIGN=1`.

**Master bypass (emergency only):** `AI_SDLC_BYPASS_ALL_GATES=1 git push` stops the entire pre-push chain — the orchestrator and all sub-hooks check this var at the very top and exit 0 immediately with a `[<hook>] AI_SDLC_BYPASS_ALL_GATES=1 — skipping` message to stderr. Use exclusively during RFC-0042 / gate-rewrite cutover windows; document every use in the PR body. Per-gate `AI_SDLC_SKIP_*` vars continue to work independently. See [`docs/operations/emergency-bypass.md`](docs/operations/emergency-bypass.md) for the full runbook.

`set -euo pipefail` aborts on first failure. `git push --no-verify` bypasses everything. All gates have hermetic tests at `scripts/<name>.test.mjs` wired via `pnpm test:drift-gate` / `test:task-move-gate` / `test:dor-gate` / `test:attestation-sign-gate` / `test:pre-push-fixups-gate`. (`test:mcp-bundle-sync-gate` removed by AISDLC-385.)

## CI behavior

PR merge gate is the single rollup check `ai-sdlc/pr-ready` produced by `.github/workflows/ai-sdlc-gate.yml` (re-actors/alls-green pattern); see [`docs/operations/quality-gate.md`](docs/operations/quality-gate.md) for archetype gating, cutover, and rollback.

Workflows MUST invoke pipeline-cli CLIs via `node pipeline-cli/bin/cli-XXX.mjs` directly — never via `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX`. `pnpm exec` does not resolve workspace own-bins, so the latter form silently fails with `Command not found` and any `|| echo <fallback>` safety net fires unconditionally. `pipeline-cli/src/cli/bin-invocation.test.ts` enforces both directions of this rule. See AISDLC-156 + the "Invoking from CI" section of `pipeline-cli/README.md`.

## Feature flags

- **`AI_SDLC_DEPS_COMPOSITION`** (RFC-0014): gates the dependency-graph composition layer. **On by default since AISDLC-410 (2026-05-23, operator override-path promotion).** Opt out via `AI_SDLC_DEPS_COMPOSITION=off` (or `0`/`false`/`no`, case-insensitive); truthy values (`1`/`true`/`yes`/`on`) are honored for backward-compat. Phase 1 surface = `cli-deps snapshot` writes `$ARTIFACTS_DIR/_deps/snapshot.<iso>.<tag>.jsonl`; `cli-deps gc/inspect` operate on those files. See [`docs/operations/deps-composition.md`](docs/operations/deps-composition.md) and [`pipeline-cli/docs/deps.md`](pipeline-cli/docs/deps.md). Phases 2-4 (PPA composition, DoR blast-radius, Slack digest) ship behind the same flag. Phase 5 ships the corpus aggregator (`cli-deps-corpus aggregate`) + operator-override capture (`cli-deps log-override`) + the hybrid promotion runbook at [`docs/operations/deps-composition-promotion.md`](docs/operations/deps-composition-promotion.md).
- **`AI_SDLC_AUTONOMOUS_ORCHESTRATOR`** (RFC-0015): gates the autonomous pipeline orchestrator. **On by default since AISDLC-411 (2026-05-23, operator override-path promotion).** Opt out via `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=off` (or `0`/`false`/`no`, case-insensitive); truthy values (`experimental`/`1`/`true`/`yes`/`on`) are honored for backward-compat and remain ON. Phase 1 surface = `cli-orchestrator {start,tick,status}` (invoke directly via `node pipeline-cli/bin/cli-orchestrator.mjs`). Phases 2-5 (failure playbook, DoR/dep admission filters, `events.jsonl` writer, soak corpus + promotion) ship behind the same flag. Phase 5 ships the corpus aggregator (`cli-orchestrator-corpus aggregate`) + chaos-test harness (`pipeline-cli/src/orchestrator/chaos.test.ts`) + the hybrid promotion runbook at [`docs/operations/orchestrator-promotion.md`](docs/operations/orchestrator-promotion.md). See [`pipeline-cli/docs/orchestrator.md`](pipeline-cli/docs/orchestrator.md) and [`spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md`](spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md).

## Code Style

- TypeScript strict, ESM. Prettier + ESLint. No premature abstractions — three similar lines beat one wrong abstraction.

## Subagent Governance — Scope Creep Prevention (AISDLC-308)

**Agents must not auto-expand scope beyond the original ask.** The PR #481 audit (2026-05-16) documented the root-cause governance gap: an agent asked to *review the state of RFCs* independently filed follow-up tasks, then dispatched implementation of those tasks within 1.5 hours — ignoring its own written "operator walkthrough required as pre-work" note. See `docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md` for the full chain.

When a review / audit / read-only task surfaces work that would be useful to do next, the agent MUST:

1. **Present the recommendation** in the review output (PR body, task summary, comment).
2. **Stop.** Wait for explicit operator authorization before:
   - Filing new backlog tasks
   - Opening any PR beyond the original ask
   - Dispatching new subagents for downstream work
3. **Treat "Pre-work required" / "Pre-conditions" / "OQ walkthrough needed" prose as a HARD precondition.** If a task body or referenced RFC flags an unresolved OQ or walkthrough requirement, the agent MUST NOT proceed to dispatch implementation until the operator confirms the precondition is met.

Every scope expansion is a decision that belongs in the [Decision Catalog (RFC-0035)](spec/rfcs/RFC-0035-decision-catalog-operator-routing.md). Surface it there for operator routing — do not self-authorize.

### Reviewer gate (AISDLC-308)

The `code-reviewer` and `test-reviewer` subagents check for scope-creep candidates in every PR: if the PR BOTH (a) implements a "review" or "audit" task AND (b) creates new files under `backlog/tasks/`, it is flagged as **critical** with the message "scope-creep candidate — verify operator authorized task creation."

### Read-only agent constraint (AISDLC-308)

Agents whose role is read-only (exploration, audit, refinement review) MUST NOT use `Write`, `Edit`, task-create MCP tools, or dispatch downstream agents. These constraints are enforced in each agent's frontmatter `disallowedTools` list and are re-stated in the agent body as **Hard rules**.

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

### RFC-0035 Decision Catalog (default-ON since AISDLC-392)

The mechanism for architectural / OQ-style decision routing is the [Decision Catalog (RFC-0035)](spec/rfcs/RFC-0035-decision-catalog-operator-routing.md). OQs project into the catalog as `Decision` records, routed to the appropriate actor (Engineering / Product / Operator), resolved asynchronously with full audit trail.

**Feature flag `AI_SDLC_DECISION_CATALOG` is default-ON (AISDLC-392, 2026-05-22).** File decisions with:

```bash
node pipeline-cli/bin/cli-decisions.mjs add --summary "<one-line>" --scope <area> --option "<id>:<description>"
node pipeline-cli/bin/cli-decisions.mjs list
```

To opt out: set `AI_SDLC_DECISION_CATALOG=off` (or `0`/`false`/`no`/`disabled`).

Dev subagents that hit an OQ-class architectural question during implementation should still escalate by returning `prUrl: null` per the protocol above. The Decision Catalog is for OPERATOR-side decision routing, not a license for dev subagents to resolve OQs in code.

### Reviewer gate (AISDLC-298)

The `code-reviewer` and `test-reviewer` subagents check for inline OQ resolutions in every PR diff. A new `**Resolution:**` marker added by a developer in an RFC's `## Open Questions` section is a **critical** finding that blocks approval.

## Review attestations

**Attestation is required for code PRs.** `/ai-sdlc execute` runs three reviewer subagents locally and writes a DSSE envelope to `.ai-sdlc/attestations/<patch-id>.dsse.json` (v5, primary, AISDLC-398) and `.ai-sdlc/attestations/<head-sha>.dsse.json` (v5, legacy compat bridge). When v6 cutover is active: `.ai-sdlc/attestations/<patch-id>.v6.dsse.json` (primary) and `.ai-sdlc/attestations/<head-sha>.v6.dsse.json` (bridge). `verify-attestation.yml` posts `ai-sdlc/attestation: success/failure` as an informational governance signal — it feeds into the `ai-sdlc/pr-ready` rollup (the single required check on `main` per AISDLC-388), not directly into branch protection. Docs-only PRs skip `verify-attestation.yml` entirely via `paths-ignore` and do not need an envelope. Code PRs must have a valid envelope; missing/invalid envelopes are visible as a check failure that operators must resolve before merging. `ai-sdlc-review.yml`'s `Post Review Results` is the parallel review-tier check (CI-side reviewers run when local attestation is missing as the cost-saver fallback).

**AISDLC-398 content-addressed envelope filenames.** The envelope's primary filename is now `<git-patch-id>.dsse.json` where the patch-id is computed from `git diff-tree --no-color -p <merge-base>..<head> -- ':!.ai-sdlc/attestations/' | git patch-id --stable`. This decouples the lookup key from git commit history: a conflict-free queue rebase changes the commit SHA but NOT the patch-id, so the verifier always finds the envelope. The per-SHA legacy filename is written as a compat bridge for one release; pre-AISDLC-398 envelopes continue to be found by the per-SHA fallback. Per-SHA legacy files scheduled for deletion in the AISDLC-398 follow-up task after soak.

**Operator action** (AISDLC-388 AC-2): branch protection on `main` should require ONLY `ai-sdlc/pr-ready` and `Backlog Drift` — NOT `ai-sdlc/attestation` directly. If your repo still lists `ai-sdlc/attestation` as a required check, run: `gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks -F 'contexts[]=Backlog Drift' -F 'contexts[]=ai-sdlc/pr-ready' -F 'strict=true'`

**RFC-0042 Phase 3 cutover — COMPLETE (AISDLC-409, 2026-05-23).** v6 is now the default attestation schema. The canonical pipeline paths (`/ai-sdlc execute`, `/ai-sdlc orchestrator-tick`) emit transcript leaves to `.ai-sdlc/transcript-leaves.jsonl` via `cli-attestation.mjs emit-leaf` as part of their reviewer fan-out, satisfying the prerequisite that gated the prior `AI_SDLC_V6_CUTOVER_ACTIVE=1` opt-in. Operators on ad-hoc reviewer flows that don't yet emit transcript leaves should pass `--schema-version v5` explicitly or set `AI_SDLC_V5_LEGACY=1` — that gap is tracked as a follow-up to AISDLC-409.

**Default schema (current): v6.** New envelopes use the RFC-6962 Merkle-transcript model per RFC-0042. `sign-attestation.mjs` reads transcript leaves from `.ai-sdlc/transcript-leaves.jsonl`, builds the Merkle tree, signs the root with the operator's key, and writes `.ai-sdlc/attestations/<head-sha>.v6.dsse.json`. The verifier (AISDLC-383.4) verifies the Merkle proof + root signature. **v5 opt-out**: pass `--schema-version v5` explicitly OR set `AI_SDLC_V5_LEGACY=1` (legacy `AI_SDLC_V6_CUTOVER_ACTIVE=0` is also honored for backward-compat). v6 mode in CI rejects missing transcript leaves (replay-attack mitigation per 383.4 security review) unless `AI_SDLC_V6_SPOT_CHECK_MODE=1` is set (operator-triggered spot-check only).

**v3/v4/v5 verifier code retained per OQ-7 (read-only).** The verifier prefers v6 when present, falls back to v5, v4, v3 for legacy envelopes. Signer code for v3/v4/v5 is retained during the 30-day soak window (deletion scheduled in AISDLC-383.7). The file collector excludes the envelope file itself so the chore-commit pattern doesn't chicken-and-egg the hash. All collectors also exclude a fixed `CONTENTHASH_SHARED_CHURN_FILES` list of shared-churn files (`pnpm-lock.yaml`, `CHANGELOG.md`, `pipeline-cli/CHANGELOG.md`, `orchestrator/CHANGELOG.md`, `reference/src/core/generated-schemas.ts`). These files are excluded on BOTH the signer and verifier sides. DO NOT add source files, test files, configs, `package.json`, or RFCs to this list. `generated-schemas.ts` is the **only** sanctioned `.ts` source-file exception (AISDLC-342).

**AISDLC-380 sub-attestation gate (post-AISDLC-409).** The gate skips entirely on v6 envelopes (Merkle-transcript model handles forgery resistance by construction). On v5 envelopes the gate now downgrades to audit-only (warn-not-block) by default. **Opt back into hard-fail**: set `AI_SDLC_V5_LEGACY=1` (or legacy `AI_SDLC_V6_CUTOVER_ACTIVE=0`) — preserves the AISDLC-380 forgery defense for operators who still sign v5 envelopes from ad-hoc reviewer flows. The gate code and sub-attestation scripts will be deleted in AISDLC-383.7 after the soak window completes. AISDLC-380.2 (architectural follow-up to close nonce/Read-tool bypasses) is marked Superseded — RFC-0042's Merkle-transcript model eliminates the attack surface it was addressing.

**Legacy v5 algorithm (AISDLC-362, retained read-only):** `computeContentHashV5(entries, signedMergeBase)` — SHA-256 of canonical JSON `{schemaVersion:'v5', signedMergeBase:'<sha>', files:[{path,blobSha}...]}`. `collectChangedFileEntriesForV5(repoRoot, baseRef, headRef)` — computes `git merge-base <baseRef> HEAD` ONCE at sign time (the FROZEN merge-base), then diffs `<signedMergeBase>..HEAD`. Non-overlapping sibling merges do not invalidate v5; overlapping (same file) sibling merges correctly invalidate it. Docs-only PRs (`spec/rfcs/**`, `docs/**`, `backlog/{tasks,completed}/**`, root `*.md`) bypass the full review+attestation pipeline: `paths-ignore` skips `ai-sdlc-review.yml` and `verify-attestation.yml` on `pull_request` events (AISDLC-388 reinstated the `paths-ignore` that AISDLC-214 removed); on `merge_group` events (where `paths-ignore` does not apply), both workflows detect docs-only changesets inline via `scripts/is-docs-only-changeset.mjs` (AISDLC-206) and short-circuit directly (AISDLC-214). The `verify-attestation.yml` short-circuit still posts `ai-sdlc/attestation: success` on merge_group docs-only events as a transitional measure; this code will be deleted once branch protection is updated (AISDLC-388 AC-4). The former fallback workflows (`ai-sdlc-review-docs-only.yml`, `verify-attestation-docs-only.yml`) have been retired — they caused CANCELLED races on the merge queue.

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

### DoR ingress workflow gate (AISDLC-379)

`.github/workflows/dor-ingress.yml`'s `evaluate-pr-tasks` job **fails the `Evaluate backlog tasks changed by PR` status check** when any PR-staged backlog task has `overallVerdict: 'needs-clarification'` AND no `blocked.reason` override in frontmatter. Pre-AISDLC-379 the workflow posted the violations comment and then exited 0, so the check returned SUCCESS and auto-merge armed against PRs with unresolved Gate-3 violations (the 2026-05-20 RFC-0041 task-breakdown incident).

The decision is computed by `pipeline-cli dor-pr-has-violations`, which consumes the same JSONL the renderer reads and applies the same `extractBlockedReason()` parser as the upstream-OQ gate — one source of truth for what "violation with no override" means. The `Fail check on unresolved violations` step exits 1 with `::error::` annotations that surface in the PR Files-changed UI.

**Operator override mirrors the upstream-OQ gate**: tasks with `blocked.reason` in frontmatter bypass the workflow gate (the comment still posts as a `(override applied)` note). Use sparingly — every override is logged to the calibration log.

**Branch-protection helper**: `scripts/sync-dor-branch-protection.sh` PATCHes the canonical required-checks list (idempotent). Edit `REQUIRED_CONTEXTS` at the top of the script to add / remove a context, then re-run. Full runbook at [`docs/operations/dor-ingress-gate.md`](docs/operations/dor-ingress-gate.md).

**Code surface**: `pipeline-cli/src/dor/pr-violations.ts` (`computePrViolations()`), the `dor-pr-has-violations` subcommand in `pipeline-cli/src/cli/index.ts`, and the `Compute has_violations` + `Fail check on unresolved violations` steps in `.github/workflows/dor-ingress.yml`. Hermetic tests: `pipeline-cli/src/dor/pr-violations.test.ts` + `.github/workflows/__tests__/dor-ingress.test.mjs`.

### Canonical execution paths

| Use case | Command | Billing |
|---|---|---|
| Internal dogfood (backlog tasks) | `/ai-sdlc execute <task-id>` (e.g. `AISDLC-393`) | Subscription (Claude Code Max) |
| Internal dogfood (GitHub issues, subscription billing) | `/ai-sdlc execute <issue-number>` (e.g. `612`, `#612`, `gh:612`) | Subscription (Claude Code Max) — AISDLC-393 |
| **Autonomous loop — single-session drain (Pattern X v2, AISDLC-396)** | `/ai-sdlc orchestrator-tick` (once, ScheduleWakeup loops). Conductor dispatches background `Agent(developer)` per manifest; dev follows its standard contract (commit → rebase → push → open DRAFT PR). Conductor's next tick **reconciles after-the-fact**: parses dev's return JSON into a verdict, fans out 3 reviewers, signs attestation, force-pushes the chore commit on top of the dev's branch, flips draft → ready. | Subscription interactive quota only — Sonnet for dev/code/test, Opus only for security. One operator-opened CC session suffices. |
| **Autonomous loop — N>4 parallel via sibling Workers (Pattern Z)** | `/ai-sdlc orchestrator-tick` + N sibling sessions running `/ai-sdlc dispatch-worker` | Subscription interactive quota only. Use when Pattern X's `inSessionAgentMaxSessions` (default 4) is insufficient for the backlog burst. |
| Operator-driven single-PR (task file + impl land together) | `cli-orchestrator tick --task-from-file <path>` (AISDLC-373) | Same as the configured `--spawner` (subscription on default `claude`) |
| Manual cleanup | `/ai-sdlc cleanup [<task-id>]` | n/a |
| Shell-driven autonomous tick (cron/daemon/sidecar; Pattern Y) | `cli-orchestrator tick --spawner claude` | Subscription (shells out to `claude -p`; draws Agent SDK credit pool post-2026-06-15). Use when no operator CC session is available. |
| GitHub issue / unattended / CI | `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` | API key |

`/ai-sdlc execute` is the default for internal work. Worktree-isolated, auto-creates sibling-repo PRs from `permittedExternalPaths`, marks Done + moves task file in the same PR.

**AISDLC-393 — argument forms.** `/ai-sdlc execute` accepts (in this precedence order): `gh:<n>` (explicit GH-issue), `<prefix>-<number>` (backlog task ID like `AISDLC-393`, including hierarchical sub-IDs like `AISDLC-100.5`), `<number>` / `#<number>` (bare/hash-prefixed numeric → GH-issue). The reference parser lives in `dogfood/src/dispatch-execute-arg.ts` (`parseExecuteArg`) with hermetic test coverage. On the GH-issue path, NO backlog task file is created — the issue is the source of truth and the PR closes it via `Closes #N`. The watcher path (`pnpm --filter @ai-sdlc/dogfood watch --issue <id>`) accepts the same argument forms via the same parser, preserved unchanged for API-key/unattended/CI use. **Dispatch wiring:** the GH-issue path uses `fetchGhIssueAsTaskSpec()` (`dogfood/src/dispatch-from-issue.ts`) to synthesise an in-memory `TaskSpec`, then dispatches via `executePipeline({ taskSpec, sourceKind: 'gh-issue', issueNumber })` — the same composite the backlog-task path uses, just with two knobs flipped. Step 1 skips `findTaskFile`; Step 4 skips the frontmatter patch (sentinel still written); Step 10 skips the tasks→completed move (attestation envelope still signed + committed); Step 11 formats the PR title with `(closes #N)` and prepends `Closes #N` to the body so the issue auto-closes on merge.

**Spawner kinds for `cli-orchestrator tick --spawner <kind>`** (AISDLC-349, default changed AISDLC-352):
- `mock` — fixtures only; for plumbing tests. Billing: none.
- `api-key` — uses `ANTHROPIC_API_KEY` via the Claude Code SDK. Billing: API token (pay-as-you-go or Agent SDK credit pool post-2026-06-15).
- `claude-cli` — **DEPRECATION UNDER REVIEW (2026-05-21)** (was RFC-0041 Phase 3.1, removal-in-v0.11). Emits a `dispatch-manifest.json` for the calling slash command body to consume via the `Agent` tool. **Only works when called from inside a Claude Code session**; fails silently with `developer-json-contract-violated` from a plain shell. The original deprecation rationale cited a "600s background-agent watchdog (~85% kill rate on real tasks)" — that claim was a misdiagnosis. Forensic scan of 73 dev subagent transcripts (via `python3 ~/.claude/skills/audit-subagent/audit.py`) found **0 watchdog kills** and 80.8% clean completion (median 16 min, max 2.5 h). The 19.2% failures are operator-initiated interrupts, not system kills. The deprecation should be re-evaluated against this corrected baseline; until then, `in-session-agent` (Dispatch Board + `/ai-sdlc dispatch-worker`) remains the documented recommended path. Suppressible: `AI_SDLC_SUPPRESS_DEPRECATION_WARNING=1`.
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

**CHANGELOG.md is managed exclusively by release-please. Contributors MUST NOT edit it manually.**

### release-please rolling PR model (AISDLC-401)

`release.yml` fires on every push to `main`, runs `googleapis/release-please-action@v4`, and
maintains a **single rolling PR** (`chore: release main` on branch `release-please--branches--main`).
The rolling PR accumulates version bumps + CHANGELOG entries from conventional-commit messages.
Regular feature PRs MUST NOT touch CHANGELOG.md — parallel-merge conflicts are the penalty
(root cause of AISDLC-401, made visible after AISDLC-400 dropped the merge queue).

The pre-push hook (`scripts/check-changelog-edit.sh`) WARNs when a feature branch touches
CHANGELOG.md. If you see that warning, revert the CHANGELOG changes — release-please will
reconstruct them from your commit messages. See [`docs/operations/release-flow.md`](docs/operations/release-flow.md) for the full flow.

### Package configuration

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
