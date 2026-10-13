---
id: AISDLC-805
title: >-
  Audit every requirement that gates a pull request under the five-step algorithm, give each an owner and origin, delete the unnecessary ones, and keep the set shrink-only through a gate registry
status: Done
assignee: []
created_date: '2026-10-10'
labels:
  - governance
  - ci
  - velocity
  - audit
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .husky/pre-push
  - .husky/pre-commit
  - package.json
  - .ai-sdlc/agent-role.yaml
  - CLAUDE.md
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator request (2026-10-10): incorporate the five-step production algorithm into the process and audit the full set of requirements gating pull requests today, so unnecessary requirements are removed rather than worked around.

**Five-step review (requirements first).** Requirement questioned: every gate below, individually; each was added after a specific incident by a named task and none has been re-examined since. Deleted: this task's output is a list of deletions, each recorded as a decision; the task itself adds one small artifact (the registry) and one test. Simplified: gates that survive are merged where two check the same property. Automated: the registry test keeps the set from growing silently.

**Inventory on main at the time of filing (counts, not judgments):**

| Surface | Count |
|---|---|
| Workflows that fire on pull request events | 10 (`ai-sdlc-gate`, `ai-sdlc-review`, `auto-enable-auto-merge`, `auto-rearm-on-dequeue`, `dor-ingress`, `isolated-review`, `require-issue-link`, `rfc-lifecycle-check`, `untrusted-pr-gate`, `verify-attestation`) |
| Jobs inside the `ai-sdlc/pr-ready` rollup | 14 |
| Required branch-protection contexts | 2 (`Backlog Drift`, `ai-sdlc/pr-ready`) |
| Pre-push gate scripts in `.husky/pre-push` | 9 scripts, plus `pre-commit` with 4 steps |
| Entries chained in the root `pnpm test` script | 59 |
| `blockedActions`/`blockedPaths` entries in `.ai-sdlc/agent-role.yaml` | 30 |
| CLAUDE.md rule sections | 23 (65 KB, re-read every session) |
| Reviewer subagents per code PR | 3 (plus Codex variants) |

**Audit method (the deliverable is `docs/operations/gate-audit-2026-10.md`).** One row per gate across all surfaces above: name; what property it protects; origin (task id, incident, or decision; "unknown" is allowed and is itself a finding); owner (role); cost (median wall-clock per run from the last 30 days of Actions history, and the local cost for hooks); failure rate and false-positive rate over the same window (a failure that was fixed by re-running or rebasing with no code change counts as a false positive); and a verdict: KEEP (why the property still matters and nothing else checks it), MERGE (into which gate), DELETE (why the property no longer needs a gate, or is checked elsewhere), or DEMOTE (informational, not blocking). Two gates with the same property are a MERGE by default. A gate with origin "unknown" and no failure in 30 days is a DELETE candidate by default.

**Decisions.** Every DELETE or DEMOTE of a governance or trust-chain control is a class (b) decision: the executor escalates one decision per gate with the audit row as the body; the planner records them; nothing is deleted in this task's PR. Deletions that loosen nothing (dead workflows, duplicate test chains, prose rules already enforced by a hook) are class (a) and may be applied in this PR.

**Registry (the ratchet).** `.ai-sdlc/gates.yaml` lists every surviving gate with name, surface, origin, owner and property. A hermetic test (`scripts/check-gate-registry.test.mjs`, wired into `pnpm test`) derives the live gate set from the workflows, hooks, `package.json` test chain and `agent-role.yaml`, and fails when a gate exists that is not in the registry or a registry entry lacks an origin or owner. The registry can shrink freely; adding an entry requires a decision id in the entry. This is the same shape as the dark-code baseline ratchet (AISDLC-552).

**Also fold in:** the root `pnpm test` chain becomes a glob runner over `scripts/*.test.mjs` and `.github/workflows/__tests__/*.test.mjs` so new gates stop editing the one line every task conflicts on (six DIRTY PRs on 2026-10-10 came from that line alone).

**Velocity impact.** Positive by construction: the task only removes or merges gates and adds one shrink-only registry.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] `docs/operations/gate-audit-2026-10.md` has one row per gate across all eight surfaces with origin, owner, cost, failure and false-positive rates from 30 days of history, and a KEEP / MERGE / DELETE / DEMOTE verdict with a one-line reason.
- [x] Every DELETE or DEMOTE of a governance or trust-chain control is escalated as its own decision with the audit row as body; class (a) deletions are applied in the PR and listed in the body.
- [x] `.ai-sdlc/gates.yaml` exists with every surviving gate and `scripts/check-gate-registry.test.mjs` fails on an unregistered gate or an entry without origin and owner; it is wired into `pnpm test`.
- [x] The root `pnpm test` script runs the gate tests through a glob, not a hand-maintained chain; the remaining chain entries are only package tests and non-glob commands.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Operator request 2026-10-10. Companion to the five-step rule (CLAUDE.md, DEC-0090) and the root-cause set in PR #1353. Trust-sensitive: the planner reviews the audit document and the registry before the flip.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Gate audit (`docs/operations/gate-audit-2026-10.md`), shrink-only gate registry (`.ai-sdlc/gates.yaml` plus `scripts/check-gate-registry.test.mjs`), and a glob runner replacing the 58-entry root `pnpm test` chain. Governance deletions are proposed as class (b) decisions D1-D15 in the audit doc; none applied.

## Changes
- `docs/operations/gate-audit-2026-10.md` (new): one row per gate, verdicts, proposed decisions.
- `.ai-sdlc/gates.yaml` (new): registry of surviving gates.
- `scripts/check-gate-registry.test.mjs` (new): ratchet test.
- `scripts/run-gate-tests.mjs` (new): glob runner.
- `package.json` (modified): chain collapsed to the runner.

## Design decisions
- **KNOWN_RED map**: two never-chained failing suites are excluded with reasons rather than fixed here.

## Verification
- `pnpm build`, `pnpm lint`, `pnpm format:check` — clean
- `pnpm test` — pipeline-cli bin-invocation/verify-runtime/TUI and some adopter-runtime tests fail locally; pipeline-cli untouched by this PR

## Follow-up
- declined: fix tasks for the two KNOWN_RED suites; the planner files them from the audit doc findings.
<!-- SECTION:FINAL_SUMMARY:END -->
