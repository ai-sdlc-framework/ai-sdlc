---
id: aisdlc-573
title: Wire nonce injection into reviewer dispatch to activate harnessTranscriptHash (AISDLC-570 activation)
status: Done
priority: high
labels:
  - attestation
  - proof-of-execution
  - aisdlc-570-followup
dependencies:
  - aisdlc-570
---

## Description

AISDLC-570 (opt-a, DEC-0013 opt1) landed the **machinery** for binding an
attestation leaf to the reviewer subagent's harness-captured execution transcript:
`pipeline-cli/src/attestation/harness-transcript.ts` computes an additive, optional
`harnessTranscriptHash`, gated on a reviewer-typed `agentType` (AISDLC-572) AND a
diff-binding **nonce literal** that must appear in the resolved harness transcript,
failing closed to `null` on any resolution failure.

**But the field is currently DORMANT.** The orchestrating dispatch — the
`/ai-sdlc execute` slash-command body / the orchestrator reconcile step that fans out
the reviewer subagents — does NOT yet (a) generate a per-PR nonce before dispatch and
(b) embed it (via `nonceMarkerLiteral()` / the agreed literal form, e.g.
`[[ai-sdlc-nonce: <hex>]]`) into each reviewer subagent's Task/Agent prompt. Because
the reviewer transcript therefore never contains the nonce, `emit-leaf` resolves
`harnessTranscriptHash = null` for essentially every real invocation (fail-safe, no
over-claim). This task activates it.

## Scope

1. In the reviewer-dispatch path (the `/ai-sdlc execute` reconcile step + the
   orchestrator-tick reconcile + any other place that spawns the 3 review subagents),
   generate the per-PR nonce (reuse the existing head-derived nonce that `emit-leaf`
   already uses so the two sides agree) and embed the literal marker string in EACH
   reviewer subagent's prompt, before dispatch.
2. Thread the Claude session id to `emit-leaf` (`--claude-session-id`) if a reliable
   source exists (per AISDLC-570 §4.3 opt-i); otherwise confirm the documented
   most-recent-fallback is acceptable and keep its race disclosure.
3. Confirm end-to-end (a real or faithfully-simulated dispatch) that after this wiring,
   a genuine reviewer subagent's transcript contains the nonce and `emit-leaf` sets a
   non-null `harnessTranscriptHash` — while a coordinator that hand-authors a transcript
   (no real subagent, no nonce in a harness transcript) still gets `null`.
4. Update the AISDLC-570 docs (RFC-0042 / whitepaper) from "dormant machinery" to
   "active": state that harnessTranscriptHash now populates for real reviewer runs,
   preserving the honest limits (sign-time provenance; coordinator with Bash can still
   forge; does not prove judgment independence).

## Acceptance Criteria

- [x] The reviewer-dispatch path(s) generate + embed the diff-binding nonce in each
      reviewer subagent's prompt before dispatch.
- [x] After wiring, a genuine reviewer subagent run yields a non-null
      `harnessTranscriptHash`; a coordinator-authored (no real subagent) path yields
      `null`. Covered by a hermetic/CI-robust test (not a macOS-only pass — AISDLC-571 lesson).
- [x] Session-id resolution finalized (explicit flag if available, else documented fallback).
- [x] Docs updated from "dormant" to "active" with honest limits intact.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note

This is the activation half of AISDLC-570; the schema + emit-leaf + verification +
fail-safe machinery is already merged. Composes with [[aisdlc-572]] (role-binding) and
sits under the DEC-0013 opt1 sign-time-only trust model. It does NOT change the honest
limit — the strong-vs-heuristic boundary is documented, not eliminated.

## Final Summary

Wired nonce generation + embedding into both canonical reviewer-dispatch paths:

- Added `cli-attestation generate-nonce --head-sha <sha>` and
  `cli-attestation nonce-marker --nonce <nonce>` subcommands
  (`pipeline-cli/src/cli/attestation.ts`) as the bash-callable single source
  of truth for the nonce format `emit-leaf`/`harness-transcript.ts` already
  expected (AISDLC-570).
- `/ai-sdlc execute` Step 7b now generates the nonce and instructs the
  operator to embed `$PR_NONCE_MARKER` verbatim in each reviewer prompt
  BEFORE spawning; Step 7c reuses the same nonce (not a fresh one) in its
  `emit-leaf --nonce` calls. Step 10.5's post-rebase re-review round
  re-derives the nonce from the new HEAD.
- `/ai-sdlc orchestrator-tick` Step 3 does the same before its reviewer
  fan-out, then threads `--reviewer-nonce` through
  `ai-sdlc-pipeline reconcile`, which passes it to every internal
  `emit-leaf` call (`pipeline-cli/src/orchestrator/reconcile.ts`,
  `RunReconcileOptions.reviewerNonce`).
- Session-id: confirmed (per AISDLC-570 §4.3 opt-i investigation, no new
  findings) there is no reliable env-var source for a running session's own
  id; both dispatch paths intentionally omit `--claude-session-id` and rely
  on the documented most-recently-modified-session-directory fallback
  (disclosed race, same heuristic as AISDLC-216).
- Docs: RFC-0042 and the proof-of-execution whitepaper updated from
  "dormant machinery" / "tracked follow-up" to "ACTIVE (AISDLC-573)",
  honest limits (sign-time-only, not CI-re-derivable, doesn't prove
  judgment independence) preserved verbatim.
- Tests: hermetic end-to-end tests in `pipeline-cli/src/cli/attestation.test.ts`
  prove `generate-nonce` → `nonce-marker` → simulated reviewer transcript →
  `emit-leaf --nonce` composes to a non-null `harnessTranscriptHash`, and
  that a transcript with no nonce embedded still yields `null`. New
  `reconcile.test.ts` cases prove `reviewerNonce` reaches every `emit-leaf`
  call verbatim (and is omitted when not provided). `execute.test.mjs` /
  `orchestrator-tick.test.mjs` assert the nonce-generation + embedding +
  reuse instructions are present in both command bodies.
