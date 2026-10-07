# CLAUDE.md reference: review attestations and remote agents

This page holds the detailed text moved out of `CLAUDE.md` (AISDLC-742) to cut the per-call context floor. The operative rules stay in `CLAUDE.md`; the explanation, incident history and implementation detail live here, essentially verbatim. Section headings below are the original `CLAUDE.md` headings.

## Review attestations

**Attestation is required for code PRs.** `/ai-sdlc execute` runs three reviewer subagents locally and writes a DSSE envelope to `.ai-sdlc/attestations/<patch-id>.dsse.json` (v5, primary, AISDLC-398) and `.ai-sdlc/attestations/<head-sha>.dsse.json` (v5, legacy compat bridge). When v6 cutover is active: `.ai-sdlc/attestations/<patch-id>.v6.dsse.json` (primary) and `.ai-sdlc/attestations/<head-sha>.v6.dsse.json` (bridge). `verify-attestation.yml` posts `ai-sdlc/attestation: success/failure` as an informational governance signal — it feeds into the `ai-sdlc/pr-ready` rollup (the single required check on `main` per AISDLC-388), not directly into branch protection. Docs-only PRs skip `verify-attestation.yml` entirely via `paths-ignore` and do not need an envelope. Code PRs must have a valid envelope; missing/invalid envelopes are visible as a check failure that operators must resolve before merging. `ai-sdlc-review.yml`'s `Post Review Results` is the parallel review-tier check (CI-side reviewers run when local attestation is missing as the cost-saver fallback).

**AISDLC-398 content-addressed envelope filenames.** The envelope's primary filename is now `<git-patch-id>.dsse.json` where the patch-id is computed from `git diff-tree --no-color -p <merge-base>..<head> -- ':!.ai-sdlc/attestations/' | git patch-id --stable`. This decouples the lookup key from git commit history: a conflict-free queue rebase changes the commit SHA but NOT the patch-id, so the verifier always finds the envelope. The per-SHA legacy filename is written as a compat bridge for one release; pre-AISDLC-398 envelopes continue to be found by the per-SHA fallback. Per-SHA legacy files scheduled for deletion in the AISDLC-398 follow-up task after soak.

**Operator action** (AISDLC-388 AC-2): branch protection on `main` should require ONLY `ai-sdlc/pr-ready` and `Backlog Drift` — NOT `ai-sdlc/attestation` directly. If your repo still lists `ai-sdlc/attestation` as a required check, run: `gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks -F 'contexts[]=Backlog Drift' -F 'contexts[]=ai-sdlc/pr-ready' -F 'strict=true'`

**RFC-0042 Phase 3 cutover — COMPLETE (AISDLC-409, 2026-05-23).** v6 is now the default attestation schema. The canonical pipeline paths (`/ai-sdlc execute`, `/ai-sdlc orchestrator-tick`) emit transcript leaves to `.ai-sdlc/transcript-leaves.jsonl` via `cli-attestation.mjs emit-leaf` as part of their reviewer fan-out, satisfying the prerequisite that gated the prior `AI_SDLC_V6_CUTOVER_ACTIVE=1` opt-in. Operators on ad-hoc reviewer flows that don't yet emit transcript leaves should pass `--schema-version v5` explicitly or set `AI_SDLC_V5_LEGACY=1` — that gap is tracked as a follow-up to AISDLC-409.

**Default schema (current): v6.** New envelopes use the RFC-6962 Merkle-transcript model per RFC-0042. `sign-attestation.mjs` reads transcript leaves from `.ai-sdlc/transcript-leaves.jsonl`, builds the Merkle tree, signs the root with the operator's key, and writes `.ai-sdlc/attestations/<head-sha>.v6.dsse.json`. The verifier (AISDLC-383.4) verifies the Merkle proof + root signature. **v5 opt-out**: pass `--schema-version v5` explicitly OR set `AI_SDLC_V5_LEGACY=1` (legacy `AI_SDLC_V6_CUTOVER_ACTIVE=0` is also honored for backward-compat). v6 mode in CI rejects missing transcript leaves (replay-attack mitigation per 383.4 security review) unless `AI_SDLC_V6_SPOT_CHECK_MODE=1` is set (operator-triggered spot-check only).

**v6 head-binding survives rebase + chore commits.** The verifier's head-binding check (envelope filename / `subject.digest.sha1` agree with HEAD) accepts two relaxations so envelopes survive normal post-sign mutations of the commit graph:

1. **Attestation-only descendant** (AISDLC-419) — when `subject.sha1` is an ancestor of HEAD and the diff between them touches ONLY `.ai-sdlc/attestations/`, `.ai-sdlc/transcript-leaves.jsonl`, and `.ai-sdlc/transcript-leaves/`. Covers the linear chore-commit case (Step 10 sign + pre-push `check-attestation-sign.sh` chain).
2. **Tree-equivalent modulo attestation** (AISDLC-448) — when `subject.sha1` is NOT an ancestor of HEAD (rebase orphaned it) but the source-tree at `subject` and at HEAD are byte-identical modulo the same attestation paths. Covers rebase + chore-commit. The Merkle root + trusted-key signature (steps 3-7 of `verifyV6Envelope`) still gate acceptance, so a rebase that resolves a real semantic conflict (i.e. changes any source byte) correctly fails verification.

Both helpers live in `scripts/verify-attestation.mjs` (`isAttestationOnlyDescendant`, `isTreeEquivalentModuloAttestation`) and share `ATTESTATION_PATH_EXCLUSIONS`. Hermetic test coverage is in `scripts/verify-attestation.test.mjs` under the matching describe blocks. Adding paths to either relaxation requires extending `ATTESTATION_PATH_EXCLUSIONS` in lockstep on the signer side (`pipeline-cli/src/attestation/patch-id.ts:PATCH_ID_EXCLUSIONS`) — asymmetric exclusion lists reproduce the AISDLC-421 hotfix class of bug (verifier computes a different patch-id than the signer).

**Three-way lockstep (AISDLC-618): the bash pre-push hook is a THIRD synchronized surface.** `scripts/check-attestation-sign.sh`'s own `git diff-tree` idempotency check (Step 4) must exclude the SAME pathspecs as `PATCH_ID_EXCLUSIONS` / `ATTESTATION_PATH_EXCLUSIONS` above — AISDLC-610 added `backlog/tasks/` + `backlog/completed/` to the signer and verifier but NOT to the hook, so every `/ai-sdlc execute` PR (which moves a task file to `backlog/completed/` in the same diff the signer signs) computed a DIFFERENT patch-id in the hook than the signer used, and the hook's idempotency check hard-aborted the push with `ERROR: signer did not produce <patch-id>.v6.dsse.json`. The fix: the hook resolves its exclusion pathspecs from `cli-attestation print-patch-id-exclusions` (single source of truth reading `PATCH_ID_EXCLUSIONS`) when the compiled CLI is available, falling back to a hardcoded `PATCH_ID_EXCLUSIONS_FALLBACK` array for fresh worktrees / hermetic test repos where `pipeline-cli/dist` doesn't exist yet. `scripts/check-attestation-sign.test.mjs` binds ALL THREE copies together, not just the two hand-copies against each other: its `AISDLC-618: bash hook fallback exclusions stay in lockstep` suite asserts (a) the hook's `PATCH_ID_EXCLUSIONS_FALLBACK` equals the test file's own `CANONICAL_PATCH_ID_EXCLUSIONS` mirror, AND (b) both of those are asserted against the REAL `PATCH_ID_EXCLUSIONS` imported from the built `pipeline-cli/dist` (skipped, not failed, when dist isn't built yet — so fresh-checkout CI ordering can't false-fail). This closes the round-2-review gap where two hand-copies could silently drift together from the real array. Adding a new exclusion to `PATCH_ID_EXCLUSIONS` MUST update all three: the TS array itself, `ATTESTATION_PATH_EXCLUSIONS` in `verify-attestation.mjs`, and `PATCH_ID_EXCLUSIONS_FALLBACK` in `check-attestation-sign.sh` — the test suite fails loudly (once dist is rebuilt) if any of the three is missed.

**v3/v4/v5 verifier code retained per OQ-7 (read-only).** The verifier prefers v6 when present, falls back to v5, v4, v3 for legacy envelopes — every historical PR remains auditable. The v5 signer path remains opt-in via `--schema-version v5` or `AI_SDLC_V5_LEGACY=1` for ad-hoc reviewer flows that have not yet wired transcript-leaf emission. The file collector excludes the envelope file itself so the chore-commit pattern doesn't chicken-and-egg the hash. All collectors also exclude a fixed `CONTENTHASH_SHARED_CHURN_FILES` list of shared-churn files (`pnpm-lock.yaml`, `CHANGELOG.md`, `pipeline-cli/CHANGELOG.md`, `orchestrator/CHANGELOG.md`, `reference/src/core/generated-schemas.ts`). These files are excluded on BOTH the signer and verifier sides. DO NOT add source files, test files, configs, `package.json`, or RFCs to this list. `generated-schemas.ts` is the **only** sanctioned `.ts` source-file exception (AISDLC-342).

**AISDLC-380 sub-attestation gate — REMOVED (AISDLC-383.7).** The per-reviewer sub-attestation gate (`scripts/check-attestation-sign.sh` Step 4d) and its supporting scripts (`scripts/verify-reviewer-sub-attestations.mjs`, `ai-sdlc-plugin/scripts/sign-reviewer-verdict.mjs`, `ai-sdlc-plugin/scripts/init-reviewer-signing-key.mjs`) were deleted in RFC-0042 Phase 4 cleanup after the 30-day soak post-AISDLC-409. v6 envelopes are resistant to unexecuted-review forgery by construction (the Merkle transcript binds reviewer evidence to committed leaves signed by the operator's key), so the audit-only fallback was no longer earning its complexity. **Honest scope (AISDLC-568):** this proves a real review ran against the exact code state by a process with repo access; it does NOT by itself prove reviewer identity or independence from the coordinator that also makes the ship decision — a coordinator willing to pay the same LLM-token cost could self-author the transcript today. The `AI_SDLC_LEGACY_VERDICTS=1` env var, the `AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD` test hook, and the `~/.ai-sdlc/reviewer-keys/` per-reviewer key directory are no longer consulted. AISDLC-380.2 (architectural follow-up to close nonce/Read-tool bypasses) was already marked Superseded by RFC-0042's Merkle-transcript model.

**Legacy v5 algorithm (AISDLC-362, retained read-only):** `computeContentHashV5(entries, signedMergeBase)` — SHA-256 of canonical JSON `{schemaVersion:'v5', signedMergeBase:'<sha>', files:[{path,blobSha}...]}`. `collectChangedFileEntriesForV5(repoRoot, baseRef, headRef)` — computes `git merge-base <baseRef> HEAD` ONCE at sign time (the FROZEN merge-base), then diffs `<signedMergeBase>..HEAD`. Non-overlapping sibling merges do not invalidate v5; overlapping (same file) sibling merges correctly invalidate it. Docs-only PRs (`spec/rfcs/**`, `docs/**`, `backlog/{tasks,completed}/**`, root `*.md`) bypass the full review+attestation pipeline: `paths-ignore` skips `ai-sdlc-review.yml` and `verify-attestation.yml` on `pull_request` events (AISDLC-388 reinstated the `paths-ignore` that AISDLC-214 removed); on `merge_group` events (where `paths-ignore` does not apply), both workflows detect docs-only changesets inline via `scripts/is-docs-only-changeset.mjs` (AISDLC-206) and short-circuit directly (AISDLC-214). The `verify-attestation.yml` short-circuit still posts `ai-sdlc/attestation: success` on merge_group docs-only events as a transitional measure; this code will be deleted once branch protection is updated (AISDLC-388 AC-4). The former fallback workflows (`ai-sdlc-review-docs-only.yml`, `verify-attestation-docs-only.yml`) have been retired — they caused CANCELLED races on the merge queue.

## Remote agents (`/schedule`) — read-only by design (AISDLC-442)

CCR remote sandboxes are **read-only by design**. They lack four prerequisites that `/ai-sdlc execute` requires:

| Missing prerequisite | Why it matters |
|---|---|
| `~/.ai-sdlc/signing-key.pem` | Signing key is operator-machine-local; CCR has no access |
| Plugin install | `mcp__plugin_ai-sdlc_ai-sdlc__*` tools are unavailable |
| Worktree filesystem | `.worktrees/<task-id>/` creation / git-worktree ops fail |
| Operator filesystem | `.ai-sdlc/trusted-reviewers.yaml` pubkeys inaccessible |

**Acceptable in CCR**: PR/backlog status surveys, cron metric digests, Slack workflows, CI run-list / flake detection, `mcp__backlog__task_create`, `mcp__github__create_issue`.

**Prohibited in CCR**: `/ai-sdlc execute`, signing-key flows, plugin subagents (`developer`, `code-reviewer`, etc.), worktree ops, sibling-repo writes.

### Local vs. remote — what works where

| Task type | Works in CCR? | Works locally? | Notes |
|---|---|---|---|
| Survey open PRs | Yes | Yes | `gh pr list` |
| Check CI run health | Yes | Yes | `gh run list` |
| Post Slack digest | Yes | Yes | Webhook call |
| File a backlog task | Yes | Yes | `mcp__backlog__task_create` |
| File a GitHub issue | Yes | Yes | `mcp__github__create_issue` |
| Run `/ai-sdlc execute` | **No** | Yes | Requires signing key + worktree |
| Sign attestation envelopes | **No** | Yes | Signing key is operator-machine-local |
| Open worktrees | **No** | Yes | `git worktree add` fails in sandbox |
| Run developer subagent | **No** | Yes | Plugin subagents unavailable in CCR |

### Supported handoff workflow

When a CCR `/schedule` task detects work that requires local execution:

1. **File a backlog task** via `mcp__backlog__task_create` — or a GitHub issue via `mcp__github__create_issue` if the work is broad.
2. **Include full context** in the task body: what triggered the work, what the expected outcome is, any relevant file paths.
3. **The local operator session picks it up** on the next `/ai-sdlc orchestrator-tick` or manually via `/ai-sdlc execute <task-id>`.

> `/ai-sdlc execute` detects CCR sandboxes at startup (AISDLC-442) and refuses with a clear error pointing here. See `docs/operations/remote-agents-readonly.md` for the full runbook.

### Detection heuristics

`/ai-sdlc execute` uses three signals (first match wins):

1. `CLAUDE_CODE_ENV=ccr` — canonical env var injected by Claude Code in CCR sessions.
2. `CLAUDE_REMOTE_EXECUTION=1` — alternative injection used in some operator configurations.
3. `CLAUDE_CODE_ENV` set (any value) + `~/.ai-sdlc/signing-key.pem` absent — likely managed sandbox; conservative fallback when (1) and (2) don't fire.

