---
id: aisdlc-572
title: verdictClass `independent` is unbound to reviewer role — marker omits agent_type, matcher checks timing only
status: Done
priority: high
labels:
  - bug
  - attestation
  - proof-of-execution
  - aisdlc-568-followup
dependencies:
  - aisdlc-568
---

## Description

verdictClass (AISDLC-568) is meant to distinguish a leaf produced by a real
independent reviewer subagent from one a coordinator authored itself. As shipped
in plugin 0.15.1 it cannot, for two compounding reasons (verified on main):

1. **The marker omits the reviewer role.** `ai-sdlc-plugin/hooks/subagent-start.js`
   reads `payload.agent_id` (~line 234) and writes only `{ agentId, firedAt }`
   (~line 251). It never reads `payload.agent_type`, even though the `SubagentStart`
   payload carries `agent_type` as a REQUIRED field (Claude Code CLI schema:
   `hook_event_name: "SubagentStart", agent_id: string, agent_type: string`; values
   are the plugin's own agent names — `code-reviewer`, `security-reviewer`,
   `developer`, …).
2. **The matcher checks timing only.** `pipeline-cli/src/attestation/verdict-class.ts`
   returns `independent` for the first marker whose `firedAt` is within the lookback
   window of the transcript mtime (~line 125), with NO reference to `agentType` — the
   marker interface has no such field and there is no role gate.

**Net:** `independent` is credited whenever ANY subagent was dispatched within the
window — a `developer`, a `rebase-resolver`, anything. A coordinator that dispatches
a `developer` subagent (which writes a marker) and then hand-authors a `code-reviewer`
transcript within the window gets `independent` with NO fabrication — an unrelated
real marker is silently reused. The signal means "some subagent ran recently," not
"this review was done by an independent reviewer" — the exact distinction the feature
exists to make.

The role IS on the wire; the hook drops it.

## Scope

1. **`hooks/subagent-start.js`:** read `payload.agent_type` (string, else null) and
   record it in the marker: `{ agentId, agentType, firedAt }`. Preserve the existing
   fail-safe behavior (missing/absent stdin still writes a marker with `agentType: null`).
2. **`verdict-class.ts`:** add `agentType` to the marker interface, and BEFORE the
   time-window check require the marker's `agentType` to be a REVIEWER role. Reviewer
   allowlist (confirm against `ai-sdlc-plugin/agents/`): `code-reviewer`,
   `test-reviewer`, `security-reviewer`, `code-reviewer-codex`, `test-reviewer-codex`
   (NOT `developer`, `rebase-resolver`, `ci-conflict-resolver`; decide whether
   `refinement-reviewer` counts — it is a DoR reviewer, not a code/test/security review
   of the diff, so exclude by default). A non-reviewer or missing `agentType` → fail
   safe to `self-authored`. Keep the existing fail-safe defaults everywhere.
3. **Narrow the lookback window** now that role-binding is the primary defense — the
   downstream prototype used 30 min vs the current 2 h. Pick a defensible value and
   document it.
4. **Secondary — single-writer/collision:** the marker at
   `.ai-sdlc/subagent-sessions/<agent-id>.json` is written with an unconditional
   `writeFileSync`. Fix (1) removes any consumer's need to register its own hook;
   document the single-writer expectation (and, if cheap, avoid clobbering a
   role-bound marker with a role-less one — e.g. don't overwrite an existing marker
   that already has a reviewer `agentType` with one that has none).

## Backward compatibility

- Existing markers without `agentType` → treated as non-reviewer → `self-authored`
  (safe; never upgrades to a false `independent`).
- Existing SIGNED v6 envelopes already carry their verdictClass in the signed leaf —
  do NOT change how historical envelopes verify. This task changes only how NEW leaves
  are classified at emit time. Confirm the verifier still accepts legacy envelopes.

## Acceptance Criteria

- [x] `subagent-start.js` reads `agent_type` and writes `{ agentId, agentType, firedAt }`;
      a hermetic test asserts `agentType` is captured from the payload and is `null` when absent.
- [x] `verdict-class.ts` returns `independent` ONLY when a matching marker's `agentType`
      is in the reviewer allowlist AND within the (narrowed) window; a marker with
      `agentType: 'developer'` (or null) in-window → `self-authored`.
- [x] Regression test reproducing the report: a `developer` marker in-window + a
      reviewer transcript → `self-authored` (not `independent`); a `code-reviewer`
      marker in-window → `independent`.
- [x] Lookback window narrowed with a documented rationale.
- [x] Legacy v6 envelopes (verdictClass present, no role in the marker model) still verify.
- [x] Docs (verdict-class.ts docblock, RFC-0042 / whitepaper) updated to state the
      role-bound semantics + the remaining honest limit.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

Implemented AISDLC-572: `subagent-start.js` now reads `payload.agent_type` and writes
`{ agentId, agentType, firedAt }` to the marker (agentType is `null` when absent/malformed,
and an existing reviewer-typed marker is never clobbered by a role-less re-fire for the same
`agent_id`). `verdict-class.ts` gates on a REVIEWER allowlist (`code-reviewer`, `test-reviewer`,
`security-reviewer`, `code-reviewer-codex`, `test-reviewer-codex`) BEFORE the timing check —
`developer`, `rebase-resolver`, `ci-conflict-resolver`, `refinement-reviewer`, and legacy/null
`agentType` markers all fail safe to `self-authored` regardless of timing. The lookback window
was narrowed from 2h to 30 minutes now that role-binding is the primary defense. RFC-0042 and
the Proof-of-Execution whitepaper were updated to describe the role-bound semantics and the
remaining honest limit (a coordinator with Bash access can still forge `agent_type`; strong
binding is AISDLC-570). Full verification (`pnpm build && pnpm test && pnpm lint && pnpm
format:check`) passed.

## Relation to AISDLC-570

This is the cheap, strictly-positive step: role-binding raises the forgery floor from
"any subagent ran" to "a reviewer-typed subagent ran." It is NOT cryptographic proof — a
coordinator with Bash can still forge a marker with a forged `agent_type`. The strong
binding (leaf ↔ the reviewer's own harness-captured execution transcript) remains the
deferred DEC-0012 / [[aisdlc-570]]. This task is a down-payment on 570, not a replacement.
