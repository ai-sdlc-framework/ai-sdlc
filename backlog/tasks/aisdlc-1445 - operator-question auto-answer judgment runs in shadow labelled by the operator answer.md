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
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/judgment/catalog
  - reference/src/judgment/evaluate.ts
  - docs/operations/judgment-promotion.md
---

## Description

Implements the `operator-question.auto-answer` judgment the RFC-0049 amendment (AISDLC-1444) specifies, in `shadow` only. The question gate (AISDLC-1443) calls it for every question that reaches the operator (after the deny checks fall through); the caller receives `abstain('shadow')`, the question is asked as today, and the operator's actual answer is joined to the logged prediction. Nothing is answered for the operator by this task; promotion to `enforce` needs the promotion record and the veto surface (AISDLC-1446), per the amendment.

Follow the amendment's resolved OQs; if any of OQ-A to OQ-D is still open when this task is claimed and blocks the work, stop and escalate (`cli-decisions escalate --scope rfc:RFC-0049`), never resolve it inline.

## Acceptance Criteria
- [ ] #1 `operator-question.auto-answer` is a catalog definition (`riskClass: relax`, `direction: bidirectional`, `egressClass` as the amendment states) with a `none-of-these` option, a pure `compose`, and the class-(c) and RFC-OQ exclusions applied before any provider call (tested: no request made).
- [ ] #2 A `PostToolUse` command hook on `AskUserQuestion` (registered in `ai-sdlc-plugin/.claude-plugin/plugin.json`) reads the operator's answer from `tool_response` and appends a `labelled` record to the AISDLC-1443 gate log (`.ai-sdlc/artifacts/_question-gate/`) under the same `questionId` (hash of question text plus options plus session id). The gate's `PreToolUse` cannot see the answer; this hook is the only writer of labels. A dismissed question or an "Other" free-text answer is recorded as unlabelled. Tested with a recorded `tool_response` fixture for each case.
- [ ] #3 `cli-judgment` gains a corpus export that joins the shadow prediction (judgment log) to the label (gate log) by `questionId` into the JSONL `cli-judgment eval --corpus` already takes; `cli-judgment eval operator-question.auto-answer --corpus <export>` reports act-band precision, coverage (share of questions it would have answered) and the confusion against operator answers.
- [ ] #4 The runtime refuses `enforce` for this judgment unless `isVetoSurfaceLive(projectRoot, sessionId, now)` from AISDLC-1446 returns true for the calling session (heartbeat file `.ai-sdlc/state/veto-surface/<session_id>.json`, fresh within 90 seconds); the gate passes the hook input's `session_id`. Tested: enforce config plus no file, a stale file, or another session's file each yield `shadow` with reason `veto-surface-not-live` logged.
- [ ] #4a The RFC-OQ exclusion in AC #1 uses the detector AISDLC-1443 exports, not a second copy.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
