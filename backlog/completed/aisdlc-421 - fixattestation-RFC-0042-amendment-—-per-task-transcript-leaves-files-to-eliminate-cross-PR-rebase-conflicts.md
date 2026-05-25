---
id: AISDLC-421
title: >-
  fix(attestation): RFC-0042 amendment — per-task transcript-leaves files to
  eliminate cross-PR rebase conflicts
status: Done
assignee:
  - '@claude-opus-4-7'
created_date: '2026-05-25 01:27'
updated_date: '2026-05-24'
labels:
  - attestation
  - v6
  - rfc-0042
  - rebase-friction
  - rfc-amendment
dependencies: []
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - scripts/verify-attestation.mjs
  - pipeline-cli/bin/cli-attestation.mjs
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`.ai-sdlc/transcript-leaves.jsonl` is a **shared append-only file** that every signing operation writes to. When PR X merges to main, every other open PR's branch has its own appended leaves on overlapping line ranges → git's 3-way merge sees "both sides appended to end" → conflict on every rebase, every time.

**Measured impact (2026-05-24 session)**: this conflict surfaced on **every single rebase** across 11 in-flight PRs (#670, 671, 672, 673, 674, 675, 676, 677, 660, 338, plus repeats after sibling merges). Always resolved with `git checkout --ours` + `git rebase --continue`. The fix is 100% mechanical (union of both sides' leaves is valid), but it forces manual intervention every time and blocks the AISDLC-420 auto-rebase workflow from completing cleanly.

## Fix — Option 1 (per-task transcript files)

Replace the single shared `.ai-sdlc/transcript-leaves.jsonl` with per-task files at `.ai-sdlc/transcript-leaves/<patch-id>.jsonl`. Each PR's signing writes to its own file. No file overlap → no merge conflicts.

### Why per-patch-id (not per-task-id)

- Patch-id is content-addressed (same as AISDLC-398 envelope filenames) — survives rebase without name changes
- Task-id collides when iter-2 sign happens after rebase (same task, different patch)
- Lookup is symmetric with envelope discovery: `<patch-id>.v6.dsse.json` ↔ `<patch-id>.jsonl`

### Architecture

1. **`cli-attestation emit-leaf`** writes to `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` instead of the shared file. Patch-id is computed once at sign time and passed to all 3 reviewer leaf emissions.
2. **`sign-attestation.mjs`** reads from `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` instead of the shared file. The envelope's Merkle tree is built from these leaves only.
3. **`verify-attestation.mjs`** looks up the per-patch-id file by:
   - Reading envelope's `subject.digest.sha1` → resolving to the same patch-id via `git patch-id --stable`
   - Falling back to scanning `.ai-sdlc/transcript-leaves/*.jsonl` and matching by leaf-hash union (if the patch-id derivation drifts)
4. **`.gitattributes`** declares the directory `.ai-sdlc/transcript-leaves/* merge=binary` — defense-in-depth so even if two PRs accidentally write to the same file, the merge surfaces as a hard conflict (not silent corruption).
5. **Migration path** (one release window): both the signer and verifier accept BOTH formats:
   - Reader: try per-patch-id file first, fall back to shared `transcript-leaves.jsonl` if absent
   - Writer: always write to per-patch-id; STOP writing to shared
   - After soak (1 release), delete the shared-file fallback in both signer and verifier
6. **RFC-0042 amendment**: add a §N "transcript-leaf storage" subsection documenting the per-patch-id layout, the rationale (cross-PR rebase friction), and the migration window. Update the `## Open Questions` if any new one surfaces.

### What stays the same

- DSSE envelope structure (unchanged — the envelope is self-contained with its own embedded leaves + proofs + root)
- Merkle tree construction (same algorithm, same leaf hash format)
- Trusted-reviewers signature verification (unchanged)
- v5 envelope handling (unchanged — this is v6-only)
- AISDLC-419 attestation-only-descendant relaxation (orthogonal — handles a different class of stale-envelope rejection)

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `cli-attestation emit-leaf` writes to `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` (creates dir if missing). Patch-id is the same algorithm used by AISDLC-398 envelope filenames.
2. `sign-attestation.mjs` reads from `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` for the leaves it includes in the Merkle tree. Falls back to `.ai-sdlc/transcript-leaves.jsonl` (read-only, for legacy envelopes) during the migration window.
3. `verify-attestation.mjs` resolves the per-patch-id file from the envelope's subject SHA. Falls back to the shared file for envelopes signed before this change.
4. `.gitattributes` declares `.ai-sdlc/transcript-leaves/* merge=binary` (or `merge=union` if union-merge proves safe on hermetic tests — the dev picks the safer option after testing both).
5. RFC-0042 amendment lands in `spec/rfcs/RFC-0042-proof-of-execution-attestation.md` documenting the per-patch-id layout + migration window + rationale.
6. Hermetic test: simulate two PRs signing in parallel, both rebase onto a main commit that merged a third PR — assert no merge conflicts on `.ai-sdlc/transcript-leaves/*.jsonl`.
7. Hermetic test: legacy envelope (pre-amendment) still verifies via the shared-file fallback.
8. `docs/operations/transcript-leaves-migration.md` runbook: what the operator does during the migration window (mostly nothing; the dual-read is transparent).
9. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean.
10. Patch coverage ≥80% on changed files.

## Out of scope (explicit)

- Deleting the shared-file fallback — separate follow-up after the 1-release soak (gated by AISDLC-NNN where N is whatever the dev assigns the cleanup task)
- v5 envelope handling (this PR is v6-only; v5 doesn't use transcript-leaves)
- Changing the envelope schema (envelope is self-contained; only the storage layer changes)
- The CI auto-rebase workflow (AISDLC-420 ships independently — this fix unblocks it from hitting the conflict during auto-rebase)

## Why this matters

Operator quote (2026-05-24): "I think there is an issue with the v6 design whenever a PR merges it will create a conflict with any subsiquent PR's because of the file .ai-sdlc/transcript-leaves.jsonl will be modified."

The friction is real, predictable, and 100% mechanical — exactly the failure mode that erodes confidence in the autonomous pipeline. AISDLC-420's auto-rebase workflow cannot ship cleanly without this fix; otherwise every auto-rebase will hit the conflict and require operator intervention.

## References

- RFC-0042 (the design being amended)
- AISDLC-398 (content-addressed envelope filenames — same patch-id algorithm)
- AISDLC-419 (attestation-only-descendant relaxation — orthogonal)
- AISDLC-420 (auto-rebase workflow that needs this fix)
- This session's 11+ manual rebase conflicts on `transcript-leaves.jsonl`
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 cli-attestation emit-leaf writes to .ai-sdlc/transcript-leaves/<patch-id>.jsonl (creates dir if missing); patch-id matches AISDLC-398 algorithm
- [x] #2 sign-attestation.mjs reads from .ai-sdlc/transcript-leaves/<patch-id>.jsonl for Merkle tree; falls back to shared .ai-sdlc/transcript-leaves.jsonl during migration window
- [x] #3 verify-attestation.mjs resolves per-patch-id file from envelope subject SHA; falls back to shared file for legacy envelopes
- [x] #4 .gitattributes declares .ai-sdlc/transcript-leaves/* with appropriate merge driver (binary or union after dev validates safety hermetically)
- [x] #5 RFC-0042 amendment lands documenting per-patch-id layout, migration window, rationale
- [x] #6 Hermetic test: two PRs sign in parallel, both rebase onto main with third PR merged — zero merge conflicts on transcript-leaves files
- [x] #7 Hermetic test: legacy envelope verifies via shared-file fallback
- [x] #8 docs/operations/transcript-leaves-migration.md runbook for the migration window
- [x] #9 pnpm build && pnpm test && pnpm lint && pnpm format:check clean
- [x] #10 Patch coverage ≥80%
<!-- AC:END -->

## Final summary

### Summary
Replaced the single shared `.ai-sdlc/transcript-leaves.jsonl` with per-patch-id files at `.ai-sdlc/transcript-leaves/<patch-id>.jsonl`, eliminating the cross-PR rebase conflict surface that was blocking AISDLC-420's auto-rebase workflow. Each PR's Merkle tree is now built from its own file (rootHash = f(THIS_PR_leaves)); signer + verifier both implement a per-patch-id-first / shared-file-fallback contract during a one-release migration window.

### Changes
- `pipeline-cli/src/attestation/merkle.ts` (modified): added `LEAVES_DIR_RELATIVE`, `leavesFilePathForPatchId()`, `loadLeavesForPatchId()`, `appendLeafForPatchId()`, and a shared `loadLeavesFromFile()`/`appendLeafToFile()` helper layer. Legacy `loadLeaves` / `appendLeaf` retained read-only for the shared-file fallback.
- `pipeline-cli/src/attestation/sign-v6.ts` (modified): `signAndWriteV6Envelope` now reads from the per-patch-id file first when a patch-id is provided, falls back to the shared file filtered by taskId. The Merkle tree is built from THIS PR's leaves only (no more cross-PR shared root).
- `pipeline-cli/src/cli/attestation.ts` (modified): `emit-leaf` accepts `--patch-id` explicitly or auto-computes via `git merge-base origin/main HEAD` + `git patch-id --stable`. Writes to per-patch-id file. Idempotency check now scopes to that file.
- `scripts/verify-attestation.mjs` (modified): added `v6LoadLeavesForPatchId()` and `v6ResolveLeavesForEnvelope()` (per-patch-id → directory scan-by-hash → shared file). `verifyV6Envelope` accepts an optional `patchIdHint` extracted from patch-id-named envelope filenames.
- `.gitattributes` (new): `.ai-sdlc/transcript-leaves/*.jsonl merge=binary` — defense-in-depth.
- `spec/rfcs/RFC-0042-proof-of-execution-attestation.md` (modified): new `### Per-PR transcript-leaf storage (AISDLC-421 amendment, 2026-05-24)` subsection documenting the rebase-friction problem, the per-patch-id fix, the sign/verify contract, the gitattributes choice + hermetic evidence, and the migration window.
- `docs/operations/transcript-leaves-migration.md` (new): operator runbook for the migration window.
- `pipeline-cli/src/attestation/per-patch-id-rebase.test.ts` (new): hermetic test for AC#6 — initializes a real git repo with three branches, merges one to main, rebases the other two, asserts ZERO conflicts. Also includes the AC#4 hermetic evidence test demonstrating that union-merge would invalidate the signed root.
- `pipeline-cli/src/attestation/legacy-shared-fallback.test.ts` (new): hermetic test for AC#7 — sign happy paths exercising the shared-file fallback, the per-patch-id-first preference, and the self-consistency of per-patch-id root recomputation.
- `scripts/verify-attestation.test.mjs` (modified): added `verifyV6Envelope (AISDLC-421 …)` describe block exercising the verifier-side per-patch-id + scan-match + shared-fallback resolution paths.
- `pipeline-cli/src/cli/attestation.test.ts` (modified): all 17 `emit-leaf` invocations now pass `--patch-id TEST_PATCH_ID` (hermetic tests have no real git worktree); assertions use the new `loadLeavesUnderTest()` helper.
- `pipeline-cli/src/attestation/sign-v6.test.ts` (modified): one assertion updated (`leafCount` now reflects this PR's tree, not the full shared file).

### Design decisions
- **`merge=binary` over `merge=union`**: per-patch-id files are disjoint by construction; the driver is defense-in-depth. Hermetic evidence shows union-merge would silently reorder leaves and invalidate the signed Merkle root (rootHash depends on leaf sequence). Binary surfaces unexpected collisions as a hard conflict instead.
- **patch-id (not task-id) as the file key**: matches AISDLC-398 envelope filename algorithm; survives rebases by construction (same diff → same patch-id → same filename).
- **Per-PR Merkle root**: each PR's tree is built from its own leaves only. Simpler than the previous "subset of full tree" semantic and removes an entire class of "rootHash depends on every other PR's history" race conditions.
- **Dual-read migration window**: both signer and verifier accept both layouts. Cleanup (deleting the shared-file fallback) deferred to a follow-up task after the one-release soak.

### Verification
- `pnpm build` — clean (all workspaces)
- `pnpm test` — all suites pass (pipeline-cli 5147 tests, orchestrator 173 test files, all others green)
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up
- After one-release soak: file a follow-up task to delete the shared-file fallback paths in both signer (`signAndWriteV6Envelope`) and verifier (`v6ResolveLeavesForEnvelope`), and delete the legacy shared file from the repo.
