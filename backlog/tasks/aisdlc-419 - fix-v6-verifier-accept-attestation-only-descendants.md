---
id: AISDLC-419
title: 'fix(verify-attestation): v6 verifier rejects envelopes whose subject.sha1 is an ancestor of HEAD via attestation-only chore commits'
status: To Do
labels:
  - bug
  - attestation
  - v6
  - ci
references:
  - scripts/verify-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - .husky/pre-push
  - scripts/check-attestation-sign.sh
priority: critical
---

## Problem

Three PRs (#654, #655, #656) are stuck on the attestation gate. Forensic inspection of `.worktrees/aisdlc-344` reveals the failure mode:

1. `/ai-sdlc execute` Step 10 signs an envelope at HEAD=`<dev-commit>` and commits it as a chore commit C1. The envelope's `subject.digest.sha1` = `<dev-commit>`.
2. The pre-push fixup hook (`scripts/check-attestation-sign.sh`) detects HEAD shifted to C1 and signs *another* envelope binding to C1, committing it as chore commit C2.
3. After push, HEAD = C2 but the *primary* envelope on disk binds to C1.
4. CI verifier sees HEAD=C2, finds the patch-id-named envelope, checks `envelope.subject.digest.sha1 === C2` → **FAIL** with `v6: envelope filename '<sha>.v6.dsse.json' does not match expected '<headSha>.v6.dsse.json' for head <head-7>`.

Concrete log from PR #654 (run 26353018837, job 77574490179):

```
reason=v6: envelope filename 'e6cbc4230d880355c7e44a0069a6eca2deac82b8.v6.dsse.json'
  does not match expected '<headSha>.v6.dsse.json' for head 84c6f9f
```

`e6cbc4230d880355c7e44a0069a6eca2deac82b8` is commit C1 (first chore commit); HEAD `84c6f9f3` is C2 (pre-push fixup chore commit). Between them: only `.ai-sdlc/attestations/*.v6.dsse.json` additions.

## Root cause

`scripts/verify-attestation.mjs:570-575` rejects any v6 envelope whose `subject.digest.sha1` differs from HEAD. This is correct in principle (replay protection) but is too strict: when one or more attestation-only chore commits sit between `subject.sha1` and HEAD, no code has changed; the envelope's claim about the diff is still accurate.

## Fix design

In `verifyV6Envelope`, after the existing binding check fails, perform a **descendant-relaxation check**:

1. Is `envelope.subject.digest.sha1` an ancestor of HEAD (via `git merge-base --is-ancestor`)?
2. Is the patch-id of `<subject.sha1>..HEAD` (excluding `.ai-sdlc/attestations/` and `.ai-sdlc/transcript-leaves.jsonl`) empty (no code diff)?

If both yes → accept the envelope. The binding still proves what was signed; the chore commits on top only added attestation files.

If either no → keep the existing rejection (replay/wrong-commit protection preserved).

## Acceptance Criteria

- [ ] #1 Add `isAttestationOnlyDescendant(subjectSha, headSha, repoRoot)` helper to `scripts/verify-attestation.mjs` that returns true iff `subjectSha` is an ancestor of `headSha` AND the patch-id of `<subjectSha>..<headSha> -- ':!.ai-sdlc/attestations/' ':!.ai-sdlc/transcript-leaves.jsonl'` is empty.
- [ ] #2 `verifyV6Envelope` calls this helper when `envelopeFileName !== expectedFileName` AND when `envelope.subject.digest.sha1 !== headSha`; on true, treat the envelope as valid for binding purposes (continue to Merkle/signature verification).
- [ ] #3 Hermetic test in `scripts/verify-attestation.test.mjs`: envelope at C1, HEAD=C2 where C1→C2 only adds attestation files — passes.
- [ ] #4 Hermetic test: envelope at C1, HEAD=C2 where C1→C2 adds a source file change — STILL FAILS (subject mismatch detected).
- [ ] #5 Hermetic test: envelope's `subject.sha1` is not an ancestor of HEAD at all — STILL FAILS.
- [ ] #6 Existing v6 verifier tests in `scripts/verify-attestation.test.mjs` (lines 3286-3590) continue to pass.

## Verification commands

- `pnpm --filter @ai-sdlc/orchestrator build`
- `node --test scripts/verify-attestation.test.mjs`

## Out of scope

- The signer-side cleanup (avoid creating two chore commits) is a separate improvement filed later; this fix unblocks the queue first.

## Why this is safe

The Merkle-transcript model (RFC-0042) already proves that the reviewer signed off on the specific set of transcript leaves for the specific subject SHA. Allowing attestation-only chore descendants:

- **Does NOT** allow replay across unrelated PRs — subject.sha1 must still be an ancestor of HEAD.
- **Does NOT** allow code-tampering between sign and push — any non-attestation diff in the descendant range fails the patch-id-empty check.
- **DOES** tolerate the pre-push hook chain's normal operating mode.
