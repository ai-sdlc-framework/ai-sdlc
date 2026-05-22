---
id: AISDLC-395
title: 'feat: wire emitDorDecisions into orchestrator DorReadiness admission filter (RFC-0035 Phase 5)'
status: To Do
labels:
  - decision-catalog
  - orchestrator
  - autonomous-loop
references:
  - pipeline-cli/src/decisions/dor-bridge.ts
  - pipeline-cli/src/orchestrator/filters/
  - pipeline-cli/src/orchestrator/loop.ts
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
blocked:
  reason: "RFC-0035 is still 'Ready for Review' (not Signed Off); Phase 5 implementation
    proceeds against the merged Phases 1-8 substrate (default-on per AISDLC-392).
    Operator-acknowledged 2026-05-22."
---

## Description

The Decision Catalog (RFC-0035) was promoted to default-on in AISDLC-392. The `dor-bridge.emitDorDecisions(verdict)` library function exists and is fully tested — but per the AISDLC-392 security review, **it is NOT called from any production code path, only from tests.**

This task wires it into the **canonical production path**: the autonomous orchestrator's `DorReadiness` admission filter. When the filter blocks a task because of unresolved DoR questions (gate-2 markers, gate-3 unresolved refs, gate-7 invisible-dependency phrases, or upstream-OQ blocks), the orchestrator should automatically file a Decision per blocking question into `.ai-sdlc/_decisions/events.jsonl` so the operator can route it asynchronously via cli-decisions or the TUI decisions pane (Phase 8).

This is the single smallest change that unlocks the autonomous-loop-with-decisions integration:

```
[orchestrator-tick]
   ↓ admission filter: DorReadiness FAIL
   ↓ NEW: emit Decision per blocking question (via dor-bridge)
   ↓ continue tick (skip this task, move to next frontier candidate)

[operator, async]
   ↓ cli-decisions list  →  sees pending decision
   ↓ cli-decisions resolve DEC-NNN <option>
   ↓ (manual: edit task file with the chosen answer)

[next orchestrator-tick]
   ↓ re-admission of previously-blocked task
   ↓ DoR passes
   ↓ dispatch dev → reviewers → sign → PR
```

(Auto-apply-decision-to-source-artifact is a separate task — Phase 5+ — not in scope here.)

## Acceptance criteria

- [ ] AC-1: `DorReadiness` admission filter in `pipeline-cli/src/orchestrator/filters/` (or wherever the dor check lives in the orchestrator loop) calls `emitDorDecisions(verdict, { workDir, env: process.env })` when the DoR verdict has unresolved questions
- [ ] AC-2: The call is GATED on `isDecisionCatalogEnabled(process.env)` — degrades open if the flag is somehow disabled (operator opt-out)
- [ ] AC-3: Emitted decisions appear in `.ai-sdlc/_decisions/events.jsonl` with `source: dor-vague` (or whichever shape `emitDorDecisions` produces) and `scope: <task-id>`
- [ ] AC-4: Idempotency — if the orchestrator ticks repeatedly and the task remains DoR-blocked, the SAME decision is NOT re-filed each tick. Use the task ID + question text as a dedup key, or check existing decisions for the same scope before emitting.
- [ ] AC-5: A new `OrchestratorEmittedDecision` event is appended to `events.jsonl` (orchestrator events stream — NOT decisions events stream) every time a Decision is filed from the admission filter. This is the audit-trail link between "DoR blocked task X" and "Decision DEC-NNN exists for it".
- [ ] AC-6: Hermetic test in `pipeline-cli/src/orchestrator/loop.dor-decisions.test.ts` covers: vague-issue verdict → DoR fail → emit Decision; second tick with same blocked task → no duplicate Decision; flag off → no Decision emitted, orchestrator still blocks; flag on (default) → Decision emitted.
- [ ] AC-7: `cli-deps frontier --format table` (per CLAUDE.md "Non-dispatchable tasks") could optionally annotate frontier entries that have pending Decisions, but that's out of scope for this task — file as follow-up if useful.
- [ ] AC-8: Docs: update `pipeline-cli/docs/orchestrator.md` (or equivalent) with a section on "Decision Catalog integration" explaining the auto-file-on-block flow.

## Hard rules

- DO NOT push or open a PR. The operator session (this one, via `/ai-sdlc execute AISDLC-395`) handles sign+push+PR.
- Single PR end-to-end. Move this task file to `backlog/completed/` per Done semantics in your work commit.
- Run `pnpm format:check` BEFORE returning to avoid prettier drift failures.
- Don't touch `.ai-sdlc/**` or `.github/workflows/**`.

## Verification (must pass)

```
pnpm --filter @ai-sdlc/pipeline-cli build
pnpm --filter @ai-sdlc/pipeline-cli test
pnpm lint
pnpm format:check
```

## Out of scope (explicit follow-ups)

- **Resolve → patch source artifact**: when a Decision is resolved, the resolution doesn't auto-edit the source task file. File as next-up follow-up.
- **Stage A auto-route on high confidence**: high-confidence + low-risk decisions could auto-resolve via a policy. File separately.
- **Slack/cli-status decision digest**: surface pending decisions in the operator's existing dashboards. File separately.
- **Phase 6 operator routing UX (AISDLC-290)**: the cli-decisions resolve interactive workflow. Already filed.

## References

- AISDLC-392 — Decision Catalog default-on promotion
- AISDLC-290 — Phase 6 operator routing UX (queued)
- RFC-0035 §14 — promotion pattern
- RFC-0015 — orchestrator admission chain
