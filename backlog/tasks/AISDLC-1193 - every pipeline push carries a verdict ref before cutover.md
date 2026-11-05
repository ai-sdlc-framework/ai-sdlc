---
id: AISDLC-1193
title: 'Every pipeline push carries a verdict ref (RFC-0061 cutover prerequisite)'
status: To Do
assignee: []
created_date: '2026-11-05'
labels:
  - rfc-0061
  - attestation
  - pipeline-cli
  - fix
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/verdict-ref-push.ts
  - pipeline-cli/src/attestation/verdict-record.ts
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
priority: high
dispatchable: true
---

## Description

**Source.** Operator in the planner session, 2026-11-05 (DEC-0375): cut over to the verdict gate now, without the shadow report. AISDLC-1172 makes `ai-sdlc/pr-ready` fail a PR with no verdict record, so the writer must cover every pipeline push first.

**Today.** Only 5 refs exist under `refs/ai-sdlc/verdicts/` on origin. Executor pushes on 2026-11-05 produced none: #2379 head 7c75e83f and #2331 head bfabe547 (pushed by the 1175 executor through Step 11) both report `no-record`. `buildVerdictRefspec` (`verdict-ref-push.ts:39`) returns no refspec when `verdict.verdictRecordDraft` is undefined, and every other failure also returns null with only a note (`ship.ts:570-577`), so a missing record is silent. Likely gaps to confirm: resumed and re-entered rounds (review-full resume, push-only resume) that never set `verdictRecordDraft`; the head changing after the draft is built (auto-sign commit in the pre-push hook) so the ref names a non-head sha; planner and rebase-resolver pushes outside Step 11.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: after cutover a PR merges only with a record for its head (RFC-0061 core requirement), so every approved pipeline push must write one or the push must say why not. 2. Deleted: nothing. 3. Simplified: one place builds the draft from the aggregated verdict, used by fresh and resumed rounds alike. 4. Accelerated: none. 5. Automated: tests below.

1. Find each path where an approved review reaches Step 11 without `verdictRecordDraft`, using the two heads above as evidence, and build the draft from the aggregated verdict on those paths.
2. The ref is keyed by the sha actually pushed (after any hook commit). If the head moves, rebuild before the atomic push.
3. A push without a verdict ref, when the review approved, logs one line naming the reason into the verdict notes (`ship.ts` `verdictNotes`) and the task verdict, so dispatch and the planner see it.
4. Pushes outside Step 11 (planner, rebase-resolver) are covered by AISDLC-1172 carry-forward (AISDLC-1170); document that in the RFC-0061 runbook section, do not add a writer there.

## Acceptance Criteria

- [ ] AC-1: A resumed round (review-full and push-only) that ends approved pushes a verdict ref for the pushed head. Test per resume kind.
- [ ] AC-2: When the pre-push hook adds a commit, the ref names the final pushed sha. Test.
- [ ] AC-3: An approved push without a ref records the reason in the verdict notes. Test.
- [ ] AC-4: `cli-attestation verdict-check --head <sha>` returns `ok` for a head pushed by a fresh executor round in an integration-style test with a local bare remote.
- [ ] AC-5: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.
