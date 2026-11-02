---
id: AISDLC-1162
title: 'cli-decisions supersede <id> --by <id> --reason closes a decision overruled by a later one; projection folds the existing superseded event type, and list, digest and handoff treat it as closed'
status: To Do
assignee: []
created_date: '2026-11-02'
labels:
  - decisions
dependencies: []
references:
  - pipeline-cli/src/decisions/decision-record.ts
  - pipeline-cli/src/decisions/projection.ts
  - pipeline-cli/src/decisions/projection.test.ts
  - pipeline-cli/src/decisions/operator-digest.ts
  - pipeline-cli/src/cli/decisions.ts
  - pipeline-cli/src/hierarchy/handoff.ts
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: medium
dispatchable: true
---

## Description

DEC-0286 (opened 2026-10-31 09:23Z, scope `task:AISDLC-1137`, options `retire-leaf` and `new-patch-id`) is still `open`. DEC-0287 (answered `latest-leaf-wins` 20:54Z) overruled it; its rationale says it "supersedes escalation DEC-0286 whose options retire-leaf and new-patch-id were both rejected", and AISDLC-1137 has since landed (#2219). The only ways to close DEC-0286 are `answer` or `resolve`, both of which record one of its options as chosen, i.e. record a ruling the operator rejected. So it stays open in `cli-decisions list`, in `handoff write`'s `## Open decisions` (`handoff.ts:139` keeps `proposed|open|deferred`) and in the planner's pending set.

The model already anticipates this: RFC-0035 section 4.2 defines a `superseded` lifecycle ("replaced by a later decision"), `decision-record.ts` lists `superseded` in both `DECISION_LIFECYCLES` (line 32) and `DECISION_EVENT_TYPES` (line 51), and `DecisionStatus.supersededBy` exists (line 216). But `applyEvent` in `projection.ts` has no `superseded` branch (it handles `decision-opened`, `timebox-extended`, `routing-changed`, `recommendation-issued`, `stage-c-completed`, `overridden`, `operator-answered`, `auto-expired`, lines 44-221), there is no event interface, and no CLI subcommand emits it.

**Five-step review (requirements first).**
1. Requirement questioned: must every decision end with one of its own options chosen? No. RFC-0035 4.2 names `superseded` as a terminal state; recording an overruled option as "answered" falsifies the audit trail.
2. Delete: nothing; the event type and lifecycle already exist and only lack a reducer and a writer.
3. Simplify: one `SupersededEvent` (`supersededBy: DEC-NNNN`, `reason`, `by`); one projection branch setting `lifecycle: 'superseded'` and `status.supersededBy`; one subcommand `cli-decisions supersede <id> --by <id> --reason <text>`. It refuses when the target is already `answered`/`archived`/`superseded`, when `--by` names an unknown decision, or when `--by` equals the target. Writes go through `resolveWriteRoot` (and the AISDLC-1161 `--file` path once it lands).
4. Accelerate: existing closed-set checks (`filterExpiredDecisions`, `route-commands.ts` `CLOSED_LIFECYCLES`, `rfc.ts` `RESOLVED_LIFECYCLES`, `resolve`/`auto-expire` guards at `decisions.ts:2014` and `:2103`) already treat `superseded` as closed, so they work with no change.
5. Automate: projection and CLI tests; the operator digest lists supersessions next to answers so the operator sees them.

Velocity impact: removes stale open decisions from every handoff and planner orientation (DEC-0286 today), and stops planners from choosing between a false `answer` and leaving it open forever.

## Acceptance Criteria

- [ ] AC-1: `decision-record.ts` defines `SupersededEvent` (`type: 'superseded'`, `supersededBy`, `reason`, optional `by`) and the event validator requires `supersededBy` matching `DEC-\d{4,}` and a non-empty `reason`.
- [ ] AC-2: `projection.ts` `applyEvent` folds `superseded` into `lifecycle: 'superseded'` and `status.supersededBy`; a projection test covers it, including that a later `operator-answered` on the same decision is ignored (immutable once closed).
- [ ] AC-3: `cli-decisions supersede <id> --by <id> --reason <text>` appends the event; it refuses an already closed target, an unknown `--by`, and `--by` equal to `<id>`; tests cover each refusal.
- [ ] AC-4: `cli-decisions list` shows `superseded` with `-> DEC-NNNN`; `handoff write` omits superseded decisions from `## Open decisions`; `operator-digest` lists supersessions since the cutoff in their own group. A test covers each surface.
- [ ] AC-5: Applying the new subcommand to DEC-0286 `--by DEC-0287` (done by the planner after merge, not by this PR) leaves DEC-0286 out of `handoff write` and the planner's pending decisions; the PR body states the exact command.

## Notes

Origin: planner session 2026-11-02, DEC-0286 still open after DEC-0287 overruled it and AISDLC-1137 landed via #2219. Premise correction: DEC-0286 has two options (`retire-leaf`, `new-patch-id`), not one; DEC-0287's rationale rejects both, so `answer` with either would record a rejected option. Related: AISDLC-1161 (`--file` write path from the parent).
