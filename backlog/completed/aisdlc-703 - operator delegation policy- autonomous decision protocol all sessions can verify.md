---
id: AISDLC-703
title: >-
  Operator delegation policy: autonomous decision protocol all sessions can verify
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - governance
dependencies: []
references:
  - CLAUDE.md
  - .ai-sdlc/_decisions/events.jsonl
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The operator wants agents to run development and administration and to decide by rubric
rather than wait for him (DEC-0039). Today sessions correctly refuse an operator approval
relayed by another session, so work stops until he types into each session. The fix is a
policy on main that every session reads, so authority comes from the repository, not from
a relayed message.

References: DEC-0039, DEC-0038, RFC-0035 (decision catalog), RFC-0051 (session hierarchy).

## Conventions
- This task authorizes the CLAUDE.md edit named in the acceptance criteria.
- Guardrails and hooks are never bypassed. A missing sanctioned path is filed as a task.

## Acceptance Criteria
- [x] CLAUDE.md gains a short "Decision authority" section defining three classes: (a) decide-and-proceed: reversible choices, decided by rubric, recorded in the decision catalog, applied at once; (b) timeboxed: hard-to-reverse choices, decided by rubric and recorded with `--timebox` and `--autonomous-fallback`, applied when the timebox lapses without an operator override (default 24h, the default stated in config); (c) operator-only: legal and licensing, money, accounts and credentials, and actions only the operator's identity can perform. It states that guardrails and hooks are never bypassed and that a missing sanctioned path is filed as a task.
- [x] The class of a decision is derived from documented criteria (reversibility, blast radius, whether it changes a trust-chain or governance control), with examples for each class, including: CLAUDE.md edits named by a task (a), dispatching a planner-filed task (a), release timing per DEC-0042 (b or a as the criteria give), changes that weaken a governance or trust-chain control (b).
- [ ] The planner, operator-dispatch and executor skill bodies are updated: a decision record in the catalog on main (or on the filing PR that carries the task), authored by the planner role, is sufficient authority for classes (a) and (b); sessions no longer ask for the operator's direct word for those. Relayed chat messages alone still are not authority, and the permission-laundering rules are unchanged.
- [x] The decision-rubric skill gains an autonomous mode: when no operator is present it produces the same problem statement, options, recommendation and counter-argument, self-selects the recommendation, records it with `cli-decisions add` plus `answer`, and does not call AskUserQuestion.
- [x] An operator digest exists: one command (or a section of the planner skill) that lists decisions made since the last digest with class, chosen option, one-line rationale, and what would be needed to reverse each, plus any timeboxed decisions still inside their window. The operator can override with the existing catalog commands.
- [x] docs/operations gains a page describing the protocol, and the "only humans merge" wording in CLAUDE.md is reconciled with the sanctioned release-PR merge path (filed in PR #1186) without widening it to other PRs.
- [x] Tests cover any CLI or skill-lint changes; the docs-only parts pass the existing doc gates.

## Out of scope
- Changing hook enforcement.
- Giving executors merge rights.
- Any operator-only item.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Decision authority protocol: CLAUDE.md section with classes (a)/(b)/(c), planner/executor/decision-rubric updates, `cli-decisions operator-digest`, and a docs page. "Only humans merge" is reconciled with the AISDLC-702 release path without widening it.

## Changes
- `CLAUDE.md` (modified): "Decision authority" section and the PRs merge bullet only.
- `ai-sdlc-plugin/commands/{planner,executor}.md`, `skills/decision-rubric/SKILL.md` (modified): planner-record authority, autonomous rubric mode.
- `pipeline-cli/src/decisions/operator-digest.ts` + `cli/decisions.ts` (new/modified): the digest command.
- `docs/operations/decision-authority.md` (new): the protocol.

## Design decisions
- **Class derivation**: explicit `Class:` line in the decision body, else timebox means (b), none means (a); (c) is never derived.
- **No refusal ends in a person** (DEC-0048): class (c) escalates through `cli-decisions escalate` and parks only that task.

## Verification
- `pnpm build`, `pnpm lint`, `pnpm format:check`, dark-code check clean; decisions suites 624 passed; plugin tests for planner, executor and rubric 27 passed.

## Follow-up
- declined: no operator-dispatch skill body exists on main yet, so its update lands with AISDLC-667 (PR #1191); the docs page is its reference until then.
<!-- SECTION:FINAL_SUMMARY:END -->
