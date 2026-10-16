---
id: AISDLC-866
title: 'chore(deps): bump js-yaml 4.3.2 to 5.4.3 under the repo identity (replaces dependabot #1445)'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [chore, deps]
dependencies: []
references: [package.json, pnpm-lock.yaml, pipeline-cli/package.json]
priority: medium
dispatchable: true
---

## Context

Dependabot PR #1445 bumps js-yaml 4.3.2 to 5.4.3. It is untrusted and red on Build & Test, Coverage, First-run smoke and Integration Tests; no attestation envelope can exist for a bot PR. Operator decision 2026-10-14 (planner session): MAJOR bumps are redone as backlog tasks under the repo identity (see AISDLC-865 for the vitest twin and DEC-0213 for the minor/patch exemption).

js-yaml 5 is ESM-first, so a `require('js-yaml')` consumer or a default-import shape can break. Declared in root `package.json` and `pipeline-cli/package.json` (`@types/js-yaml` ^4.0.9 is a devDependency of pipeline-cli; check whether v5 ships its own types and drop the `@types` package if so).

Consumers found with `grep -rlE "from 'js-yaml'|require\('js-yaml'\)"` (excluding node_modules, dist, .worktrees):

- pipeline-cli/src: pipeline/trust-classifier.ts, pipeline/ast-gate.ts, pipeline/sandbox-runner.ts, capture/capture-lifecycle.ts, capture/draft-capture.ts, review-plan/config.ts, hierarchy/brief-format.ts, hierarchy/operational.ts, tui/tui-config.ts, tui/config-browser/validator.ts, tui/sources/backlog-walker.ts, dispatch/idle-backoff.ts, dispatch/recommend-worker.ts, usage/usage-config.ts, decisions/judged.ts, decisions/fatigue.ts, decisions/decision-exemplars.ts, decisions/decisions-config.ts, decisions/pending-exemplars.ts, classifier/substrate/override.ts, classifier/substrate/corpus.ts, classifier/substrate/config.ts, steps/02-compute-branch.ts, steps/01-validate.ts, knowledge/ontology.ts, knowledge/config.ts, knowledge/entry.ts, import-spec/config.ts, routing/load-table.ts, orchestrator/hc-cost.ts
- scripts/check-gate-registry.test.mjs
- .github/workflows/__tests__/codeql.test.mjs, .github/workflows/__tests__/trust-marker.test.mjs

## Fix

**Five-step review (requirements first).** Requirement questioned: "does every dependency bump need a signed review?" Answer for majors: yes, because the js-yaml 5 migration can change parse and dump behaviour that tests and the First-run smoke depend on. Nothing to delete, except `@types/js-yaml` if v5 bundles types. Simplified: one bump, one PR, all consumers on the same import shape. Accelerated: start from the dependabot lockfile result. Automated: nothing new; the existing gate chain is the check.

1. Read the js-yaml 5 changelog; list breaking changes (ESM-first, removed or renamed exports, schema or `load` strictness, `dump` output differences).
2. Bump `js-yaml` in root and `pipeline-cli` package.json; regenerate `pnpm-lock.yaml` under nvm Node 22.23.2.
3. Fix each consumer above that breaks; keep one import style across them.
4. Run `pnpm build && pnpm test && pnpm lint && pnpm format:check`, plus the First-run smoke and integration suites that #1445 failed.

## Acceptance Criteria

- [ ] AC-1: package.json and `pnpm-lock.yaml` updated to js-yaml 5.4.3; `@types/js-yaml` removed if redundant.
- [ ] AC-2: `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; First-run smoke and Integration Tests green in CI.
- [ ] AC-3: the PR body lists each js-yaml 5 behaviour change that needed a source or test edit.
- [ ] AC-4: the PR body notes that dependabot #1445 is superseded; the operator closes it.
- [ ] AC-5: reviewers run and the attestation envelope is signed as for any code PR.

## Out of scope

Other dependency bumps; replacing js-yaml with another parser.
