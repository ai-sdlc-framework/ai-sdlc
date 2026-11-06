---
id: AISDLC-1173
title: >-
  RFC-0061 Phase 3: delete the v6 signer, verifier, patch-id code, committed
  proof trees and signing-key setup
status: In Progress
assignee: []
created_date: '2026-11-03'
labels:
  - rfc-0061
  - attestation
  - review-gate
  - cleanup
  - phase-3
dependencies:
  - AISDLC-1172
references:
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - pipeline-cli/src/pipeline/clean-room-signer.ts
  - pipeline-cli/src/cli/attestation.ts
priority: medium
dispatchable: true
drift_status: flagged
drift_checked: '2026-11-06'
drift_log:
  - date: '2026-11-06'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      pipeline-cli/src/attestation/patch-id-exclusion-lockstep.test.ts
    resolution: flagged
  - date: '2026-11-06'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/commands/init-signing-key.md
    resolution: flagged
  - date: '2026-11-06'
    type: dep-resolved
    detail: Dependency AISDLC-1172 has been completed
    resolution: flagged
---

## Description

Implements RFC-0061 Migration Path phase 3 (code half) and OQ-3's hard cut.

**Scope.**
1. Delete the v6 signer and verifier, v6 leaf emission and the Merkle construction, the five patch-id implementations, `patch-id-exclusion-lockstep.test.ts` and the exclusion list. Schema v6 is refused as a signed or verified format.
2. Delete `.ai-sdlc/attestations/` and `.ai-sdlc/transcript-leaves/` from the tree (git history keeps them), and the legacy `.ai-sdlc/transcript-leaves.jsonl`. Remove their chore-path handling in `merge-if-eligible`, `ship.ts`, `drop-chores.ts` and the growth measure in `attestation-growth.ts`.
3. Delete `init-signing-key`, the doctor keyring checks and the key-related init manifest entries. `trusted-reviewers.yaml` and its drift workflow are deleted unless another consumer remains; name any that does in the PR.
4. Remove v6 signing from the clean-room job.
5. **Operator step (class c, credentials):** deleting the repository secret `AISDLC_SIGNING_KEY_CONTENT` is the operator's action. The task escalates it with `cli-decisions escalate` and does not attempt it.
6. `pnpm dark-code:check` passes with no new baseline entries.

## Acceptance Criteria

- [ ] AC-1: No source file imports a deleted v6 module, and the build, tests, lint and dark-code check pass.
- [ ] AC-2: `.ai-sdlc/attestations/` and `.ai-sdlc/transcript-leaves/` are gone from the tree.
- [ ] AC-3: A v6 envelope given to `cli-attestation verify` is refused with a named error.
- [ ] AC-4: The secret deletion is raised as a decision record, not performed.
