---
id: AISDLC-471
title: >-
  fix(attestation): auto-sign hook must commit per-patch-id leaves file
  alongside envelope
status: To Do
assignee: []
created_date: '2026-05-28 23:21'
labels:
  - bug
  - attestation
  - auto-sign
  - pre-push-hook
  - ci-divergence
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Bug

`scripts/check-attestation-sign.sh` (pre-push auto-sign hook) creates a chore commit that includes the v6 attestation envelope file (`.ai-sdlc/attestations/<patch-id>.v6.dsse.json`) but DOES NOT include the per-patch-id transcript-leaves file (`.ai-sdlc/transcript-leaves/<patch-id>.jsonl`).

The leaves file gets written to the worktree by `cli-attestation.mjs emit-leaf` BEFORE signing, but the auto-sign hook's `git add` step only picks up the envelope, leaving the leaves file untracked.

## CI failure mode

CI checks out the branch tree → finds the envelope but NOT the per-patch-id leaves file → falls back to legacy shared `.ai-sdlc/transcript-leaves.jsonl` (which contains leaves from OTHER PRs, e.g. AISDLC-444 in the 2026-05-28 incident).

The verifier recomputes the Merkle root from the WRONG leaves → root ≠ what envelope was signed against → `v6: rootSignature did not match any trusted reviewer pubkey`.

**Local doesn't reproduce** because local verifier reads the per-patch-id file from the worktree's filesystem directly (it's there, even if not committed). CI only sees the committed tree.

## Repro (the 2026-05-28 #752 incident)

1. Dev/operator runs `/ai-sdlc execute AISDLC-N` OR pushes a PR through Pattern X v2
2. Pre-push hook emits leaves to `.ai-sdlc/transcript-leaves/<patch-id>.jsonl`
3. Pre-push hook signs envelope at `.ai-sdlc/attestations/<patch-id>.v6.dsse.json`
4. Hook creates chore commit with `git add .ai-sdlc/attestations/` + commits
5. Push succeeds locally; CI fails with rootSignature mismatch

## Fix

In `scripts/check-attestation-sign.sh`:

```bash
# When committing the auto-sign chore, also add the per-patch-id leaves file
# AISDLC-XXX (this task): per-patch-id leaves must travel with the envelope
git add .ai-sdlc/attestations/ .ai-sdlc/transcript-leaves/
git commit -m "..."
```

The `git add .ai-sdlc/transcript-leaves/` line is the load-bearing addition.

## Workaround for any open PR hitting this today

Manually amend the auto-sign chore commit to include the per-patch-id file:
```bash
cd .worktrees/<task-id>
git add .ai-sdlc/transcript-leaves/<patch-id>.jsonl
git commit --amend --no-edit
git push --force-with-lease
```

## Acceptance Criteria
<!-- AC:BEGIN -->
(See below.)

## References

- 2026-05-28 PR #752 incident — symptom: `ai-sdlc/attestation: v6: rootSignature did not match any trusted reviewer pubkey`. Diagnosed: CI log "leaves source: shared (legacy fallback)" vs local "per-patch-id". Root cause: per-patch-id file missing from commit tree.
- `scripts/check-attestation-sign.sh` — file to fix
- `scripts/verify-attestation.mjs` — verifier preferring shared fallback is documented behavior; the fix is on the signer side
- AISDLC-421 — introduced per-patch-id leaves files; auto-sign hook predated this
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 scripts/check-attestation-sign.sh's commit step adds `.ai-sdlc/transcript-leaves/` directory in addition to `.ai-sdlc/attestations/`
- [ ] #2 Hermetic test in scripts/check-attestation-sign.test.mjs that verifies: after auto-sign chore commit, `git ls-tree HEAD` shows both the envelope AND the per-patch-id leaves file
- [ ] #3 Regression test: simulate a fresh PR going through Pattern X v2 + auto-sign + push; verify CI's verify-attestation.mjs picks per-patch-id source (not legacy shared fallback)
- [ ] #4 Documentation in docs/operations/attestation-troubleshooting.md or similar: 'if you see rootSignature did not match any trusted reviewer pubkey on a PR you signed yourself, check whether the per-patch-id leaves file is in the commit tree'
<!-- AC:END -->
