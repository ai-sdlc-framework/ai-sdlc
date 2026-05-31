---
id: AISDLC-491
title: >-
  Attestation rebase-invariance — stop forcing a re-sign on every main landing
  (merge-queue OR v6-verifier-rebase-fallback bug)
status: To Do
assignee: []
created_date: '2026-05-31'
labels:
  - attestation
  - ci-friction
  - merge-race
  - rfc-0042
dependencies:
  - AISDLC-475
  - AISDLC-490
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Operator report 2026-05-31: "with every PR that lands we need to re-sign the attestation gate."** Confirmed during a multi-PR burst: PR #808 (AISDLC-475) required ~10 re-signs to land because each concurrent landing on main (#812, #813, then #808 itself for siblings #798/#804) re-staled its attestation.

## Root cause

`strict:true` branch protection + NO merge queue (dropped AISDLC-400; merge-race tracked as AISDLC-487) means every open PR goes BEHIND main the instant anything merges. The auto-rebase watcher (AISDLC-460) rebases the PR; the rebase changes the worktree tree; the v6 head-binding cannot anchor and the verifier falls through to the legacy `contentHashV4` path → `contentHashV4 mismatch` → forced re-sign.

## Why AISDLC-475 + AISDLC-490 do NOT fully fix this

- AISDLC-475 (remove per-SHA bridge) + AISDLC-490 (cut the post-sign chore commit) only stop *self*-induced HEAD movement (the sign chore commit).
- They do NOT stop *rebase-onto-new-main* re-staling. The loop recurs on every concurrent landing even after both ship.

## The two candidate fixes (decide via walkthrough)

1. **Merge queue** — reinstate a merge queue so merges serialize; PRs stop rebase-thrashing against a moving main. Directly resolves AISDLC-487. Cost: queue latency.
2. **Rebase-invariant v6 verifier** — the patch-id is SUPPOSED to be base-independent (AISDLC-398), so a clean rebase should preserve the same patch-id and the envelope should stay valid. The fact it re-stales to a `contentHashV4` (legacy v4/v5) mismatch on rebase means the **v6 verifier is dropping to the legacy fallback when it should accept the rebased envelope via patch-id** — a verifier bug. Investigate why a clean rebase (no source change) does not hit the AISDLC-448 tree-equivalent-modulo-attestation relaxation, and fix so a clean rebase keeps the envelope valid with NO re-sign.

These are not mutually exclusive; (2) is the more fundamental fix.

## NOTE — walkthrough recommended
This touches the attestation trust chain + merge policy. Recommend an operator walkthrough (like AISDLC-475/DEC-0008) before implementation to choose merge-queue vs verifier-fix vs both. Mark needs-walkthrough.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 WALKTHROUGH GATE: operator chooses merge-queue vs rebase-invariant-verifier vs both; decision recorded (Decision Catalog) before code
- [ ] #2 A clean rebase of an attested PR onto a new main (no source change) does NOT require a re-sign — the existing v6 envelope verifies valid post-rebase
- [ ] #3 Hermetic test: attest a PR, land an unrelated commit on main, rebase the PR, run verify-attestation → status=valid with NO new sign commit
- [ ] #4 If merge-queue chosen: PRs serialize so concurrent landings don't force rebases (or document why verifier-fix alone suffices)
- [ ] #5 Regression guard: a rebase that DOES change source (real conflict resolution) still correctly INVALIDATES the attestation (replay protection preserved, per AISDLC-475 AC#7c)
<!-- AC:END -->

## References
- AISDLC-475 (per-SHA bridge removal), AISDLC-490 (cut chore commit), AISDLC-487 (merge-race), AISDLC-398 (content-addressed patch-id), AISDLC-448 (tree-equivalent relaxation), AISDLC-460 (auto-rebase watcher), DEC-0008
- scripts/verify-attestation.mjs, pipeline-cli/src/attestation/patch-id.ts

## Root cause (confirmed 2026-05-31 via code investigation)

Two independent traces of `scripts/verify-attestation.mjs` confirmed the exact mechanism. AISDLC-398 made the envelope FILENAME content-addressed (`<patch-id>.v6.dsse.json`) but the patch-id is **only a lookup key — it is never used as a validity gate** (used at ~lines 2100/2165 for filename lookup only). Validity still hinges on whole-tree head-binding:

1. PR-B signed at dev commit `S`. PR-A merges → auto-rebase watcher rebases PR-B → `S` orphaned (new HEAD `C`).
2. `isAttestationOnlyDescendant` (~line 182): `git merge-base --is-ancestor S C` exits 1 (rebase orphaned `S`) → fails.
3. `isTreeEquivalentModuloAttestation` (~line 298) runs `git diff <S> <C> -- ':!.ai-sdlc/attestations/' ...` — a **WHOLE-TREE** diff, not scoped to PR-B's own patch. `C` contains PR-A's merged (disjoint) files; `S` does not → diff non-empty → returns false.
4. Both relaxations fail → falls to legacy contentHashV4 → mismatch → `ai-sdlc/attestation` FAILURE → forced re-sign.

So even fully-disjoint PRs invalidate each other on every main landing, exactly as the operator observed.

## The fix (decide in walkthrough; recommended option A)

- **Option A (surgical):** make `isTreeEquivalentModuloAttestation` (verify-attestation.mjs ~line 298) **patch-scoped** — scope the `git diff <S> <C>` to ONLY the files the envelope's own patch touched (derivable from `git diff-tree <subject-merge-base>..<S>` with PATCH_ID_EXCLUSIONS), instead of the whole tree. The check becomes "do PR-B's own files have identical blobs at S and C?" — preserved by any disjoint rebase. Add a `changedPaths` param; fall back to whole-tree (conservative) only when the subject merge-base is unreachable. Regression guard: a rebase that DOES change PR-B's own files still fails (replay protection preserved).
- **Option B (deeper, base-independent validity):** embed the patch-id INSIDE the v6 envelope (schema change) and gate validity on "recomputed patch-id of HEAD's diff == envelope patch-id" + Merkle-root signature, dropping whole-tree head-binding entirely. This is what AISDLC-398 intended architecturally.
- **Option C:** reinstate a merge queue (serializes merges so PRs never rebase-thrash) — resolves AISDLC-487 but adds queue latency and doesn't fix the underlying verifier asymmetry.

Recommend A now (unblocks concurrent disjoint merges with minimal trust-chain change), B as the long-term architecture. Source: `scripts/verify-attestation.mjs` `isTreeEquivalentModuloAttestation` (~line 278-313), `isAttestationOnlyDescendant` (~line 173-218); `pipeline-cli/src/attestation/patch-id.ts`.
