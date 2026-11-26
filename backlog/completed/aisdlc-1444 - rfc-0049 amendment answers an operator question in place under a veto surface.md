---
id: AISDLC-1444
title: "RFC-0049 amendment: a relax-class judgment may answer an operator question in place, only under a visible veto surface"
status: Done
priority: high
labels:
  - rfc-0049
  - rfc-amendment
  - judgment
  - governance
dispatchable: false
dependencies: []
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - docs/operations/decision-authority.md
  - docs/operations/judgment-promotion.md
---

## Description

Operator 2026-11-26: many questions the operator is asked could be answered automatically by the judgment layer; answered questions must be surfaced so the operator can veto them as soon as possible ("we don't want rubber stamps to get out of hand without any visibility").

RFC-0049 places stakes-bearing decisions with the human (Motivation table) and says the operator keeps decisions. Answering an `AskUserQuestion` in place removes the human from a decision, so it is a new `relax`-class integration surface and needs an amendment with operator sign-off before any code acts. This task writes that amendment; it is planner and operator work (`dispatchable: false`), walked through with the `rfc-oq-walkthrough` skill.

The amendment adds to section 5 a new judgment `operator-question.auto-answer` (in a new group, not Group C: RFC-0049 Group C is "heuristics with a working incumbent", and "always ask the operator" is not a heuristic; the amendment names the group) and states, as draft text:

- **Input:** the question, its 2–4 options with descriptions, the session's recent context window (bounded by `buildState`), and the decision records the gate shortlisted.
- **Output:** a `choice` over the question's own options plus an explicit `none-of-these / ask the operator` option.
- **Direction and risk:** `bidirectional`, `riskClass: relax`; untrusted work is tighten-only (section 4), so it never answers on untrusted input.
- **Never answered:** class-(c) questions (deterministic markers, before the judgment runs) and RFC Open Questions (AISDLC-298 rule; the operator resolves those through the rubric).
- **Visibility precondition:** no answer acts in `enforce` unless the veto surface (AISDLC-1446) is installed and live in that session; otherwise the outcome is downgraded to `shadow`, enforced in code like the existing promotion-record check.
- **Record:** every acted answer is a Decision Catalog record (class (a) or (b), `--by judgment:<model>`), so the existing reverse path (`cli-decisions answer DEC-NNNN <other option>`) is the veto.
- **Corpus:** shadow outcomes are labelled by the operator's actual answer to the same question; `cli-judgment eval` scores them.

## Open Questions (to be resolved with the operator through the decision rubric; this task MUST NOT resolve them)
- **OQ-A Promotion bar:** the runtime already requires, for a `relax` judgment, act-band precision ≥ 0.95 on a corpus with `n >= minN` and no cache hits, and refuses override promotion (`reference/src/judgment/evaluate.ts:131`). Is that enough for answering on the operator's behalf, or does it need a higher bar, a larger minimum corpus, or a per-question-kind bar?
- **OQ-B Veto window and visibility:** does an auto-answer take effect at once with a veto afterwards, or wait a short window (seconds to minutes) for a veto before the session proceeds? And is "veto surface loaded in the session" (the AISDLC-1446 heartbeat) enough, or must the operator be shown to be watching (an attached pane, recent input)?
- **OQ-C Scope:** planner session only, or also interactive non-hierarchy sessions?
- **Provider (not open):** DEC-0435 option a (no Claude-model fallback; answer record PR #3067) means only a calibrated provider can act; the amendment cites DEC-0435 and the existing `uncalibrated-provider` downgrade (`evaluate.ts:153`) rather than reopening it. If #3067 has not merged when this task starts, stop and say so.

## Acceptance Criteria
- [x] #1 RFC-0049 gains a dated Revision History row and section 5/8 text for `operator-question.auto-answer` covering every bullet above; lifecycle stays Signed Off only if the operator confirms the extension (as for the 2026-09-30 amendment), otherwise it returns to Ready for Review.
- [x] #2 OQ-A to OQ-C are listed in the RFC's Open Questions and resolved only through the operator rubric walkthrough; each resolution recorded with a DEC id.
- [x] #3 Implementation tasks for the amendment (AISDLC-1445, AISDLC-1446) are named in the Implementation Plan.
- [x] #4 Engineering and Product sign-off rows added for the amendment. Product review is required (RFC-0049 already carries a "Product review (2026-11-25)" section); until Product signs, the amendment is recorded as provisional and 1445/1446 stay shadow-only.
