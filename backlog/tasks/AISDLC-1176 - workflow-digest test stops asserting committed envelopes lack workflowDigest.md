---
id: AISDLC-1176
title: 'workflow-digest test asserts no committed envelope carries workflowDigest, so every hook-signed push since AISDLC-1164 is refused'
status: In Progress
assignee: []
created_date: '2026-11-03'
labels:
  - attestation
  - pipeline-cli
  - bug
  - hotfix
dependencies: []
references:
  - pipeline-cli/src/attestation/workflow-digest.test.ts
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
priority: high
dispatchable: true
---

## Description

**Five-step review (requirements first).**
1. Question the requirement: the assertion `expect(e.workflowDigest).toBeUndefined()` in the "workflowDigest in the schema" block was a snapshot of the state before any signer wrote the field. AISDLC-1164 made the plugin signer write it, so the snapshot is no longer a requirement. The requirement that stays is that every committed envelope passes the digest rule.
2. Delete: delete that one assertion.
3. Simplify: keep the `verifyWorkflowDigest(...) toBeNull()` loop and the "not required" schema check unchanged.
4. Accelerate: no change.
5. Automate: the existing test covers it.

**Observed 2026-11-03.** Since #2314 (AISDLC-1164) merged at 18:25Z, the pre-push hook signs each task push with an envelope carrying `workflowDigest` (`path: builtin:execute-task`), commits it, then runs the tests on that tree. `workflow-digest.test.ts:131` fails on the hook's own envelope and the hook refuses the push. AISDLC-1166 (#2319), AISDLC-1167 (#2321) and AISDLC-1175 (#2331) are all stuck this way, with no envelope on the remote branch and the attestation gate reporting a content-hash mismatch. Removing the one line makes all 15 tests in the file pass on the 1175 signed head `a04b407d`.

**Fix.** Delete the `expect(e.workflowDigest).toBeUndefined();` line. Nothing else.

**Out of scope:** any signer or verifier change.

## Acceptance Criteria

- [ ] AC-1: `workflow-digest.test.ts` no longer asserts that committed envelopes lack `workflowDigest`, and it still asserts each committed envelope passes `verifyWorkflowDigest` with no workflow state.
- [ ] AC-2: The file's tests pass with an envelope carrying a `builtin:execute-task` digest present in `.ai-sdlc/attestations/`.
- [ ] AC-3: The diff touches only that test file, plus this task's lifecycle files.
