---
id: AISDLC-657.2
title: >-
  RFC-0050: align the default artifacts directory of the model resolver with the scorecard and replay commands
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - docs
dependencies:
  - AISDLC-657
references:
  - docs/operations/model-routing.md
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The model resolver (`pipeline-cli/src/routing/artifacts-dir.ts`) defaults its artifacts directory to `.ai-sdlc/artifacts` under the project, while `cli-usage scorecard` (`pipeline-cli/src/usage/scorecard-commands.ts`) and `cli-usage replay` (`pipeline-cli/src/usage/replay-commands.ts`) default to `artifacts`. With `ARTIFACTS_DIR` unset, the assignment log lands where the scorecard does not read, so the scorecard silently shows zero explored tasks. Make the defaults agree and update `docs/operations/model-routing.md`.

## Acceptance Criteria
- [ ] With `ARTIFACTS_DIR` unset, the resolver, the scorecard and replay use the same directory, in a test.
- [ ] The advice to set `ARTIFACTS_DIR` in `docs/operations/model-routing.md` is updated.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
