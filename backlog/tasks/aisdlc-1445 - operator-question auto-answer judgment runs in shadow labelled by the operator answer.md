---
id: AISDLC-1445
title: "operator-question.auto-answer judgment runs in shadow, labelled by the operator's actual answer"
status: To Do
priority: medium
labels:
  - judgment
  - rfc-0049
dependencies:
  - AISDLC-1442
  - AISDLC-1443
  - AISDLC-1444
  - AISDLC-1447
assumes: [RFC-0049]
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/judgment/catalog
  - reference/src/judgment/evaluate.ts
  - docs/operations/judgment-promotion.md
---

## Description

Implements the `operator-question.auto-answer` judgment the RFC-0049 amendment (AISDLC-1444) specifies, in `shadow` only. The question gate (AISDLC-1443) calls it for every question that reaches the operator (after the deny checks fall through); the caller receives `abstain('shadow')`, the question is asked as today, and the operator's actual answer is joined to the logged prediction. Nothing is answered for the operator by this task; promotion to `enforce` needs the promotion record, the OQ-8 promotion conditions and a delivered digest (AISDLC-1446), per the amendment (RFC-0049 section 5 Group D and section 8; OQ-8 DEC-0436, OQ-9 DEC-0437, OQ-10 DEC-0438). The resolutions are provisional until Product signs the amendment; until then this judgment ships `shadow`-only.

Follow the amendment's resolved OQs; if any of OQ-8 to OQ-10 is reopened when this task is claimed and blocks the work, stop and escalate (`cli-decisions escalate --scope rfc:RFC-0049`), never resolve it inline.

## Acceptance Criteria
- [ ] #1 `operator-question.auto-answer` is a catalog definition (`riskClass: relax`, `direction: bidirectional`, `egressClass` as the amendment states) with a `none-of-these` option, a pure `compose`, and the class-(c) and RFC-OQ exclusions applied before any provider call (tested: no request made).
- [ ] #2 A `PostToolUse` command hook on `AskUserQuestion` (registered in `ai-sdlc-plugin/.claude-plugin/plugin.json`) reads the operator's answer from `tool_response` and appends a `labelled` record to the AISDLC-1443 gate log (`.ai-sdlc/artifacts/_question-gate/`) under the same `questionId` (hash of question text plus options plus session id). The gate's `PreToolUse` cannot see the answer; this hook is the only writer of labels. A dismissed question is recorded as unlabelled. An "Other" free-text answer is recorded as `deviation: true, label: unknown` (OQ-8), never as unlabelled and never as agreement. Each labelled record carries the recommended option id from the gate log (AISDLC-1447) and `deviation: true` when the operator's choice differs from it. Tested with a recorded `tool_response` fixture for each case.
- [ ] #3 `cli-judgment` gains a corpus export that joins the shadow prediction (judgment log) to the label (gate log) by `questionId` into the JSONL `cli-judgment eval --corpus` already takes; `cli-judgment eval operator-question.auto-answer --corpus <export>` reports act-band precision, coverage (share of questions it would have answered) and the confusion against operator answers. Only labels at least 28 days old count; the report prints the deviation-set size and accuracy on it, and the promotion record is refused unless n >= 50, act-band precision >= 0.95 and deviation accuracy >= 0.80 on >= 20 deviation labels (OQ-8). Tested with a fixture corpus that clears the precision bar but fails the deviation test.
- [ ] #4 The runtime refuses `enforce` for this judgment, yielding `shadow` with the reason logged, when (a) the calling session's `AI_SDLC_HIERARCHY_ROLE` is not `planner` (reason `not-planner-session`, OQ-10), or (b) the digest delivery record written by AISDLC-1446 shows no delivery in the last 26 hours (reason `digest-not-delivered`, OQ-9). Tested: enforce config with each condition false yields `shadow`; with both true and a promotion record, `enforce`.
- [ ] #4b Veto-rate demotion (OQ-8): when more than 2 of the last 20 enforced answers were reversed (a later `operator-answered` event on the answer's DEC record choosing another option), the runtime yields `shadow` with reason `veto-rate-demoted` until a new promotion record is written. Tested with a fixture event log of 3 reversals in 20.
- [ ] #4c An enforced answer is written as a Decision Catalog record (class (a), `--by judgment:<provider>@<model>`, probability in the rationale) before the session proceeds, so `cli-decisions answer DEC-NNNN <other option>` reverses it.
- [ ] #4a The RFC-OQ exclusion in AC #1 uses the detector AISDLC-1443 exports, not a second copy.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
