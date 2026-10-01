---
id: AISDLC-636.1
title: >-
  RFC-0049 follow-up (security): permissiveAllowed for dor.stage-b-pass keys off the task file's origin, not the code path
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - judgment-layer
  - dor
  - security
dependencies:
  - AISDLC-636
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/dor/ingress-claude.ts
  - pipeline-cli/src/dor/composite.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from an executor or reviewer report on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Security finding on AISDLC-636 (#1144): `refineBacklogTask` hard-codes
`source: 'backlog'`, and that path is also reached by `cli-dor-check`,
`dor-refine-task` and the spec-kit import, which can run on contributor-authored task
files. A permissive `dor.stage-b-pass` outcome could therefore be granted to a task
file that did not come from the trusted backlog. Must land before `dor.stage-b-pass`
is promoted to `enforce`.

## Scope
1. Define task-file origin as a property of the file, resolved by code: `trusted` when
   the task file exists on the base ref (`origin/main`) with the same id, or was
   created by an operator session on the operator filesystem; `untrusted` when it was
   introduced by a PR tree, an import, or an unknown source.
2. Thread the origin into `evaluateIssueE2E` and the judgment context's `sourceKind`
   so `permissiveAllowed` is true only for trusted origin, regardless of which CLI or
   entry point invoked the evaluation.
3. `cli-dor-check`, `dor-refine-task` and the spec-kit import pass the origin they can
   establish and default to `untrusted` when they cannot.
4. Record the origin and the resulting `permissiveAllowed` on the DoR calibration log
   entry.

## Acceptance Criteria
- [ ] A task file present on the base ref evaluates with `permissiveAllowed` true; the same file introduced only in a PR tree, or via the import path, evaluates with it false (one test per entry point).
- [ ] With `permissiveAllowed` false, `dor.stage-b-pass` never produces an admit; `dor.stage-b` fails still apply.
- [ ] The calibration log entry records origin and `permissiveAllowed`.
- [ ] Existing DoR tests pass unchanged for the trusted path.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
