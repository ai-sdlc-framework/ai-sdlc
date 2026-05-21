---
id: AISDLC-383.8
title: 'feat(pipeline): emit transcript leaves during pipeline execution (v6 cutover prerequisite)'
status: To Do
assignee: []
created_date: '2026-05-21'
labels:
  - rfc-0042
  - phase-3
  - attestation
  - pipeline
parentTaskId: AISDLC-383
dependencies:
  - AISDLC-383.1
  - AISDLC-383.2
  - AISDLC-383.6
priority: high
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - pipeline-cli/src/attestation/merkle.ts
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - scripts/check-attestation-sign.sh
  - ai-sdlc-plugin/commands/execute.md
---

## Scope (RFC-0042 Phase 3 prerequisite — gap identified by AISDLC-383.6 security review)

The RFC-0042 v6 attestation chain now has all three layers implemented:

- **AISDLC-383.1** ships transcript capture in reviewer subagents (writes `.ai-sdlc/transcripts/<task-id>/<reviewer>.jsonl`)
- **AISDLC-383.2** ships the Merkle leaf library (`appendLeaf`, `computeMerkleRoot`, `verifyInclusion` in `pipeline-cli/src/attestation/merkle.ts`)
- **AISDLC-383.3** ships the v6 signer (reads from `.ai-sdlc/transcript-leaves.jsonl`)
- **AISDLC-383.4** ships the CI verifier (recomputes from `.ai-sdlc/transcript-leaves.jsonl`)
- **AISDLC-383.6** ships the cutover scaffolding gated on `AI_SDLC_V6_CUTOVER_ACTIVE=1`

**Missing piece**: nothing in the pipeline appends to `.ai-sdlc/transcript-leaves.jsonl` automatically. The signer + verifier expect leaves to be present, but no code emits them during normal pipeline execution. This was flagged as a CRITICAL by the 383.6 security review: without leaf emission, every v6 sign throws `[sign-v6] No transcript leaves found for taskId 'X'`, blocking every push.

This task closes that gap. **Required prerequisite before the operator flips `AI_SDLC_V6_CUTOVER_ACTIVE=1`.**

## Deliverables

1. **Pipeline integration point** — after each reviewer subagent completes (in the slash command body's Step 7 review fan-out), compute the leaf entry from the reviewer's transcript file and the structured verdict, then call `appendLeaf` to persist it.
2. **Leaf shape population** — per RFC-0042 §Layer 2:
   - `leafIndex`: next sequential index from existing `.ai-sdlc/transcript-leaves.jsonl`
   - `taskId`: from `.active-task`
   - `reviewerName`: which reviewer (code-reviewer, test-reviewer, security-reviewer, code-reviewer-codex, test-reviewer-codex)
   - `transcriptHash`: SHA-256 of the JSONL file
   - `nonce`: `generateNonce(headSha)` from `pipeline-cli/src/attestation/merkle.ts`
   - `harness`: `claude-code` or `codex`
   - `model`: from the reviewer's stop_reason metadata or the agent definition's frontmatter
   - `verdictApproved`: from the verdict JSON
   - `findings`: bucket counts from the verdict JSON (critical/major/minor/suggestion)
   - `signedAt`: ISO-8601 timestamp at append time
3. **Atomicity** — leaves must be appended BEFORE `sign-attestation.mjs --schema-version v6` is invoked, otherwise the signer throws.
4. **Backward-compat** — when `AI_SDLC_V6_CUTOVER_ACTIVE` is unset (current default), the pipeline still works (the leaf emission is harmless overhead in v5 mode; the v6 signer is never invoked).
5. **Hermetic tests** — cover (a) leaves appended for each reviewer; (b) leafIndex monotonically increasing across multiple PRs in the same repo; (c) transcript hash matches the file; (d) v6 signer succeeds after leaves are present.
6. **Concurrency** — the `appendLeaf` TOCTOU race flagged by the 383.2 security review (acknowledged as a deferred follow-up) becomes load-bearing here. Either fix it inline (use `O_APPEND` with `appendFileSync` or an advisory lock) or document it as a known limitation in the slash command body with a follow-up task.

## Acceptance criteria

- [ ] #1 After the 3-reviewer fan-out in `/ai-sdlc execute` Step 7, `.ai-sdlc/transcript-leaves.jsonl` contains one new leaf per reviewer
- [ ] #2 Leaf fields populated correctly per RFC-0042 §Layer 2 schema
- [ ] #3 `node ai-sdlc-plugin/scripts/sign-attestation.mjs --schema-version v6 --task-id AISDLC-N` succeeds end-to-end with leaves present
- [ ] #4 With `AI_SDLC_V6_CUTOVER_ACTIVE` unset, pipeline still works (v5 default; leaves are emitted but not consumed)
- [ ] #5 With `AI_SDLC_V6_CUTOVER_ACTIVE=1`, the same `/ai-sdlc execute` run produces a v6 envelope that `scripts/verify-attestation.mjs` accepts
- [ ] #6 Hermetic tests cover happy path + leafIndex monotonicity + missing-transcript edge case
- [ ] #7 New code reaches 80%+ patch coverage

## Out of scope

- Deletion of v3/v4/v5 signer code (AISDLC-383.7, after 30-day soak)
- Spot-check tooling for missing/GC'd transcripts (`cli-attestation spot-check`) — separate follow-up if needed
- Operator-facing dashboard for leaf-index inspection — separate task

## Why this is the gating prerequisite for cutover activation

`AI_SDLC_V6_CUTOVER_ACTIVE=1` flips the default from v5 to v6. Once flipped, every `/ai-sdlc execute` produces a v6 envelope. v6 envelopes require `.ai-sdlc/transcript-leaves.jsonl` to exist with leaves matching the PR's reviewer runs. **Without this task shipped, flipping the env var bricks the entire pipeline.** Per the 383.6 security review handoff documented in PR #599's review thread.

## Source

- RFC-0042 §Layer 2 (leaf shape)
- AISDLC-383.6 security review CRITICAL #1 (filed in PR #599 on 2026-05-21)
- AISDLC-383.4 security review (referenced the same prerequisite from the verifier side)
