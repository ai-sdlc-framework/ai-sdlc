---
id: AISDLC-457
title: >-
  DoR Gate 7 invisible-dependency check — narrow regex to skip non-tracked-work
  phrases
status: Done
assignee:
  - '@claude'
created_date: '2026-05-28 00:12'
completed_date: '2026-05-27'
labels:
  - dor-rubric
  - rfc-0011
  - operator-friction
  - false-positive
dependencies: []
references:
  - pipeline-cli/src/dor/gates/gate-7-deps.ts
  - pipeline-cli/src/dor/comment-loop.ts
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
priority: medium
blocked:
  reason: "RFC-0011 upstream-OQ gate misparses RFC-0011 Q10 resolution prose (literal 'Q10: ... Stage A is $0' text in the resolution paragraph is read as an unresolved OQ); RFC-0028 is Ready-for-Review (not yet Signed Off — task references it as a real-world incident, not as a runtime dep). Operator override acknowledged 2026-05-27 by Dominique Legault."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

DoR Gate 7 (invisible-dependency phrases) is overly aggressive: flags any task body containing `requires` or `depends on` as a dependency phrase needing a tracked-work reference. Real incident 2026-05-27: PR #743 (RFC-0028 walkthrough) failed twice because:
1. `"promotion to evolving requires RFC amendment"` — that's a procedural rule, not a tracked-work dependency
2. `"Statistical drift detection depends on a rolling 30d baseline"` — that's an algorithmic prerequisite, not a tracked-work dependency

Both rephrased to `"needs"` / `"uses"` to bypass the gate. The gate currently can't tell prose like "X uses a Y" apart from "X requires AISDLC-N to be done first."

## Acceptance criteria

- [x] AC-1: Gate 7 regex narrows to phrases like `depends on AISDLC-`, `requires AISDLC-`, `blocked by RFC-`, etc. — i.e. dependency phrases that immediately precede a tracked-work identifier (AISDLC-N / RFC-N / GH issue / file path)
- [x] AC-2: Bare `requires` / `depends on` / `needs` in prose without an adjacent tracked-work reference does NOT trigger Gate 7
- [x] AC-3: New positive test fixtures: prose like "X requires Y configuration" / "X depends on Z baseline" pass without flag
- [x] AC-4: Existing negative test fixtures preserved: dep-phrase + tracked-work-id pairs (e.g. `depends&nbsp;on AISDLC-NNN` / `requires #NNN` where NNN is a real numeric id) still flag
- [x] AC-5: Renderer also fix (separate concern, file as own AC): when Gate 7 fails it should always emit the violation detail; current renderer at `pipeline-cli/src/dor/comment-loop.ts:101` emits the "blocked on the following gates:" header with zero detail when violations exist but pass severity filters, producing non-actionable output

## References

- pipeline-cli/src/dor/gates/gate-7-deps.ts (Gate 7 implementation — formerly mis-referenced as `seven-point-rubric.ts`)
- pipeline-cli/src/dor/comment-loop.ts:101 (renderer that produces empty gate-list output)
- PR #743 incident (RFC-0028 walkthrough — operator hit twice)
- PR #742 incident (AISDLC-447 + 451 backlog tasks — Claude hit during this session)
- spec/rfcs/RFC-0011-definition-of-ready-gate.md (DoR rubric source of truth)

## Final summary

Inverted Gate 7's regex semantics from "fires on any dep phrase, passes if a ref is in the same sentence" to "fires only on dep-phrase + tracked-work-id pairs, passes if the captured id is in the `references[]` list". The new combined regex `DEP_PHRASE_WITH_REF_RE` matches a phrase like `requires|depends on|blocked by|after|once|needs|prerequisite` immediately followed by `AISDLC-N | RFC-NNNN | (gh)#N | org/repo#N | https URL | file path`. Natural-English prose like "promotion to evolving requires RFC amendment" or "depends on a rolling 30d baseline" no longer matches and therefore no longer flags Gate 7.

Also fixed the comment-loop renderer at line 101: when the `## Issue not yet ready for execution` / "blocked on the following gates" header fires, the per-gate detail block now always emits — falling back to all `verdict === 'fail'` gates when no `severity === 'block'` fails exist (warn-severity fails are surfaced with `(severity: warn)` suffix to keep the signal labeled correctly). Block-severity fails still take precedence when present, so the signal-to-noise on standard blocked verdicts is unchanged.

Corpus fixtures updated to use the new semantics (real `AISDLC-115.1` / `RFC-0011` ids stubbed in the corpus root, plus a URL ref for the gate-5-must-fail edge-case fixture).
<!-- SECTION:DESCRIPTION:END -->
