---
id: AISDLC-388
title: 'chore: exclude docs-only PRs from attestation requirement (architectural)'
status: Done
labels:
  - architecture
  - attestation
  - branch-protection
  - tech-debt-removal
references:
  - .github/workflows/verify-attestation.yml
  - .github/workflows/ai-sdlc-gate.yml
  - scripts/is-docs-only-changeset.mjs
  - scripts/check-attestation-sign.sh
  - docs/operations/quality-gate.md
  - docs/operations/gate-friction-audit-2026.md
parentTaskId: AISDLC-384
---

## Description

Surfaced by the AISDLC-384 gate-friction audit (operator question during Gate 6 review): "docs require attestation but there is nothing for them to review, so can we exclude docs from attestation?"

The current architecture is a band-aid pattern:

- `ai-sdlc/attestation` is a REQUIRED status check on main branch protection (per AISDLC-193)
- Docs-only PRs have nothing to attest, but the required-check rule forces a status to be posted on every PR head SHA
- **AISDLC-214** (CI workaround): `verify-attestation.yml` short-circuits on docs-only changesets and posts `ai-sdlc/attestation: success` directly without verifying any envelope
- **AISDLC-215** (pre-push workaround, being deleted in AISDLC-387): synthesizes a fake 3-reviewer verdict and signs an envelope nobody reads
- Both are workarounds for "the required check must be posted, even when it makes no sense"

The deeper fix is to redesign branch protection so docs PRs don't need the attestation status posted at all.

## Architectural proposal

| Layer | Today | Proposed |
|---|---|---|
| Branch protection required checks on `main` | `ai-sdlc/pr-ready` AND `ai-sdlc/attestation` | Just `ai-sdlc/pr-ready` (the rollup) |
| `ai-sdlc/attestation` status | REQUIRED → must be posted on every head SHA → forces docs short-circuit + synthesis | Regular check — only runs and posts when changeset contains code |
| `ai-sdlc/pr-ready` (rollup, `.github/workflows/ai-sdlc-gate.yml`) | Currently waits on all required statuses + posts alls-green | Per-archetype: docs-only → check lint+format+docs-build; code → also check attestation |
| `verify-attestation.yml` | Always runs (paths-ignore removed in AISDLC-214); short-circuits on docs-only | Reinstate `paths-ignore` for docs paths OR only run conditionally on code changesets |
| AISDLC-214 (CI docs short-circuit) | Required to satisfy branch protection | DELETE — no longer needed |
| AISDLC-215 (pre-push docs synthesis) | Already DELETED in AISDLC-387 | (already gone) |
| Local pre-push attestation-sign hook | Always tries to sign when active-task + verdict exists | Unchanged (already correctly no-ops when verdict file missing post-387) |

## Acceptance criteria

- [ ] AC-1: `ai-sdlc/pr-ready` rollup workflow (`.github/workflows/ai-sdlc-gate.yml`) is updated to skip attestation requirement when changeset is docs-only. Use the existing `scripts/is-docs-only-changeset.mjs` detector.
- [ ] AC-2: Branch protection rule on `main` updated to require ONLY `ai-sdlc/pr-ready` (not `ai-sdlc/attestation` directly). This is an operator-side GitHub UI / API change — document the exact API call in the PR body and capture the before/after state.
- [ ] AC-3: `verify-attestation.yml` reinstates `paths-ignore` for docs paths on `pull_request` events. On `merge_group` events (where `paths-ignore` doesn't apply), the inline docs-only short-circuit may stay since merge-group runs are cheap and the short-circuit is a one-step no-op.
- [ ] AC-4: AISDLC-214's "always post status on every head SHA" code path can be DELETED from `verify-attestation.yml` once branch protection no longer requires the check. Verify before deletion.
- [ ] AC-5: Update `docs/operations/quality-gate.md` to reflect the new model (single required rollup, attestation as a conditional contributor).
- [ ] AC-6: Update `CLAUDE.md` "Review attestations" section: the line "verify-attestation.yml posts `ai-sdlc/attestation: success/failure` (required status on `main` per AISDLC-193)" is no longer accurate; attestation feeds into pr-ready not directly into branch protection.
- [ ] AC-7: Validate end-to-end with both a docs-only PR and a code PR:
  - Docs-only PR: `ai-sdlc/pr-ready` SUCCESS without `ai-sdlc/attestation` ever being posted → merge unblocked
  - Code PR: `ai-sdlc/pr-ready` SUCCESS requires `ai-sdlc/attestation` SUCCESS (existing flow preserved)
- [ ] AC-8: Update `docs/operations/gate-friction-audit-2026.md` to note this architectural fix shipped.

## Risks + mitigations

- **Branch protection touch is sensitive**: removing a required check from `main` is irreversible without admin re-add. Mitigation: stage in a way where the new pr-ready logic is verified working BEFORE the required-check rule changes. Two-PR cutover may be safest (PR 1: update pr-ready to gate attestation conditionally; PR 2: update branch protection rule after main confirms pr-ready behaves correctly).
- **Forgery vector regression**: AISDLC-380 forgery defense relies on attestation gates. Confirm v6 cutover preserves the trust chain when attestation is only required for code PRs (it does — non-code PRs have no code to forge).
- **Merge queue interaction**: if branch protection on `merge_group` differs from `pull_request`, the architecture must handle both. Document.
- **Re-running checks on amended pushes**: the original AISDLC-214 motivation was GitHub not reliably re-running paths-ignore-skipped checks on later commits. If we reinstate paths-ignore, validate this isn't still an issue under the new design.

## Estimated effort

2-3 days implementation including the branch protection cutover dance. Operator-in-loop for the branch-protection touch.

## Out of scope

- Refactoring `pr-ready` to handle non-attestation per-archetype skips (e.g. skipping coverage for docs-only) — separate audit if needed.
- Changing how attestation envelopes are signed or verified — that's RFC-0042 territory.

## References

- AISDLC-387 — tactical deletion of AISDLC-215 synthesis (this task's prerequisite)
- AISDLC-214 — the CI workaround being made unnecessary
- AISDLC-193 — original "attestation as required check" decision
- AISDLC-380 — sub-attestation gate (preserved as-is)
- AISDLC-383.6 — RFC-0042 Phase 3 cutover (active as of 2026-05-22)
- [Gate friction audit § Gate 6](docs/operations/gate-friction-audit-2026.md#gate-6) — surfaced the architectural concern
