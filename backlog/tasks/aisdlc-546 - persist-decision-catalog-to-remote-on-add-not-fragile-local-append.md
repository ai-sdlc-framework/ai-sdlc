---
id: AISDLC-546
title: >-
  fix(decisions): persist Decision Catalog to the remote on `cli-decisions add`
  so Pattern-C parent resets can't wipe un-synced decisions (number reuse)
status: To Do
assignee: []
labels:
  - bug
  - governance
  - decision-catalog
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - pipeline-cli/src/cli/decisions.ts
  - scripts/check-orchestrator-state.sh
  - .ai-sdlc/_decisions/events.jsonl
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The RFC-0035 Decision Catalog is a committed/remote artifact (`.ai-sdlc/_decisions/events.jsonl`
is tracked on `origin/main`, and `.ai-sdlc/_decisions/**` is attestation-exempt via
`verify-attestation.yml` paths-ignore). BUT `cli-decisions add` only **appends to the local
working-tree** `events.jsonl` — persistence to the remote currently relies on a **periodic
manual sync PR** (e.g. `chore: sync decision catalog … (manual sync) (#833)`).

**The bug (observed 2026-06-13):** in a Pattern-C orchestrator checkout the parent working tree
is reset with `git reset --hard origin/main` by the orchestrator-state guard
(`scripts/check-orchestrator-state.sh`, run at Step 0 of every `/ai-sdlc execute` /
`orchestrator-tick`). That **wipes any un-synced `cli-decisions add` append before it is ever
committed/pushed**. The decision is lost, AND because numbering is derived from the (post-reset)
local ledger = the committed state, the next `add` **reuses the freed number**. Concretely:
an earlier `DEC-0011` (ABAC empty-allowlist fail-open) was added locally, wiped by a reset, and
the number was then reassigned to a *different* decision (the attestation subject-binding
relaxation) — two distinct decisions, one number, the first lost entirely. The committed ledger
also has gaps (DEC-0004/0005/0007 absent) consistent with the same loss-before-sync pattern.

A governance audit trail that can silently drop records + reuse IDs is not trustworthy. Decisions
must persist to the remote the moment they are filed — not depend on a manual sync that a routine
parent reset can pre-empt.

**Fix direction (pick + implement; this is a small design choice, document it):**
- **Preferred — durable `add`:** make `cli-decisions add` (and `answer`) **commit the
  `events.jsonl` change and open/append a docs-style sync PR automatically** (the `_decisions`
  path is already attestation-exempt, so the PR auto-merges fast), OR push to a dedicated
  decisions-sync branch. The decision is on the remote the instant it is filed.
- **Alternative/complement — sync-before-reset:** have `check-orchestrator-state.sh` (and the
  inline `runParentBranchGuard`) **sync/stash `.ai-sdlc/_decisions/` (and any other local-append
  governance ledger) to the remote BEFORE the `git reset --hard`**, so an un-synced append is
  never destroyed. Generalize to the underscore-ledger class if other dirs (`_audit/`,
  `_subscription-ledger/`) share the fragility.
- **Numbering integrity (required either way):** derive the next `DEC-NNNN` from the
  **committed** `origin/main` ledger (fetch first), not the local working tree, and detect/refuse
  a collision — so a wipe can never cause ID reuse.

**Scope note:** keep the change to the decisions persistence + numbering path; do not alter the
existing decision *schema* or the routing semantics (RFC-0035). Coordinate with DEC-0011 (the
attestation relaxation) only insofar as both touch `.ai-sdlc/` governance data.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A decision filed via `cli-decisions add` is persisted to `origin/main` (committed + pushed, auto-merging via the attestation-exempt `_decisions` path) WITHOUT a separate manual sync step
- [ ] #2 A subsequent parent `git reset --hard origin/main` (orchestrator-state guard) does NOT lose the decision — it is already on the remote (verify with a reproduction: add → reset → confirm the decision survives)
- [ ] #3 `DEC-NNNN` numbering is derived from the committed `origin/main` ledger (after fetch); a freed/duplicate number can never be reassigned (collision is detected + refused or auto-bumped)
- [ ] #4 `cli-decisions answer` (operator resolution) persists the same durable way
- [ ] #5 Hermetic test reproduces the add→parent-reset→survives flow and the no-ID-reuse guarantee; existing decisions tests + lint pass
- [ ] #6 docs/operations (decision-catalog runbook, if present) updated to state decisions auto-persist to the remote (no manual sync); the manual-sync step is retired or documented as a fallback only
<!-- AC:END -->
