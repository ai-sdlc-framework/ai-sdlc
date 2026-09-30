---
id: AISDLC-637
title: >-
  RFC-0049 Group B: advisory dev.ac-coverage and review.finding-grounding judgments
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-6
  - review
  - pipeline
dependencies:
  - AISDLC-631
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/steps/06-parse-dev-return.ts
  - pipeline-cli/src/steps/08-aggregate-verdicts.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - orchestrator/src/review-meta.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two checks on agent output that run before more agent time is spent. Both are advisory
in v1: they annotate and notify, and they never change a verdict, a finding, the
reviewer set or the attestation. RFC-0049 section 5, Group B.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0049-system-one-judgment-layer.md`. Its Open Questions
  are resolved; do not edit that section. If the RFC and this task disagree, stop and
  return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- No vendor SDK and no new runtime dependency. HTTP goes through an injectable `fetch`;
  tests never touch the network.
- Every new module is reachable from a non-test importer or a barrel re-export, so the
  dark-code gate passes (`pnpm dark-code:check`).
- Strings an adopter can see (errors, CLI output, templates) carry no internal task ids.

## Scope
1. **`dev.ac-coverage`**: `egressClass` `code-diff`, `riskClass` `tighten`,
   `direction` `tighten-only`. Runs after Step 6 parses the developer return
   (`pipeline-cli/src/steps/06-parse-dev-return.ts`). State: the task's acceptance
   criteria as an array and the diff against the merge base, redacted. One Noul per
   criterion asks whether the diff contains a change that addresses that criterion,
   referring to it by array path. Output: a list of criterion, probability and a
   `likely-uncovered` flag for those below threshold. When the diff exceeds the state
   budget the runtime abstains with `state-too-large`; do not truncate or sample.
2. **`review.finding-grounding`**: `egressClass` `agent-output`, `riskClass` `tighten`,
   `direction` `tighten-only`; it also sends a code excerpt, so it runs only when both
   `agent-output` and `code-diff` are allowed. Runs after reviewer verdicts are
   collected, before aggregation in `pipeline-cli/src/steps/08-aggregate-verdicts.ts`.
   For each finding with a file and line:
   - In code, with no model: the file exists at the reviewed commit and the line is in
     range. A failure is annotated `location-not-found`.
   - Otherwise one Choice per finding over `supports`, `contradicts`, `unrelated`,
     `cannot-tell`, asking how the cited excerpt (the line with 30 lines of context
     either side) relates to the finding's claim. All findings for a PR go in as few
     requests as the state budget allows.
   Output: one annotation per finding. Findings, severities and `approved` are returned
   unmodified.
3. **Surfacing:** both results go to the judgment log and are returned on the step
   result as new optional fields. When any criterion is `likely-uncovered` or any
   finding is `contradicts`, `unrelated` or `location-not-found`, emit
   `JudgmentEscalated`, and Step 11 (`pipeline-cli/src/steps/11-push-and-pr.ts`) adds a
   short "Judgment notes (advisory)" section to the PR body listing them.
4. **Not changed:** verdict aggregation rules, the verdict file, transcript leaves, and
   `orchestrator/src/review-meta.ts` (its hook stays as is; this task does not drop or
   re-rank findings).

## Acceptance Criteria
- [ ] With the layer disabled, the outputs of Step 6, Step 8 and Step 11 are unchanged on existing fixtures.
- [ ] `dev.ac-coverage` sends one Noul per acceptance criterion in a single request and flags criteria below the threshold as `likely-uncovered`.
- [ ] A diff larger than the state budget results in abstain `state-too-large` and no provider request.
- [ ] `review.finding-grounding` annotates a finding citing a missing file or an out-of-range line as `location-not-found` without calling the provider for it.
- [ ] Verdict aggregation output (`approved`, counts by severity, blocking) is identical with and without grounding annotations present.
- [ ] `review.finding-grounding` does not run when only one of `agent-output` and `code-diff` is allowed.
- [ ] Step 11 adds the advisory section only when there is something to report, and the section contains no internal task ids.
- [ ] A `JudgmentEscalated` event is emitted for an uncovered criterion and for a `contradicts` finding.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
