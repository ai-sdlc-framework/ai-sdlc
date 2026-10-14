---
id: AISDLC-865
title: 'chore(deps): bump vitest 4.1.11 to 5.0.3 under the repo identity (replaces dependabot #1446)'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [chore, deps, testing]
dependencies: []
references: [package.json, pnpm-lock.yaml, pipeline-cli/package.json, orchestrator/package.json]
priority: medium
dispatchable: true
---

## Context

Dependabot PR #1446 bumps vitest 4.1.11 to 5.0.3. It is untrusted and red on Build & Test and on `ai-sdlc/attestation` (no attestation envelope can exist for a bot PR). Operator decision 2026-10-14 (planner session): MAJOR dependency bumps are redone as backlog tasks under the repo identity; minor and patch bumps follow the dependabot attestation exemption recorded in DEC-0213.

vitest is declared in every workspace package that runs tests (pipeline-cli, orchestrator, reference, dogfood, sdk-typescript, dashboard, mcp-advisor, ai-sdlc-plugin/mcp-server, ai-sdlc-plugin/mods, vscode-hierarchy, conformance/runner). `forge-data-room-kit` pins 3.2.7 and is out of scope.

## Fix

**Five-step review (requirements first).** Requirement questioned: "does every dependency bump need a signed review?" Answer for majors: yes, because the vitest 5 migration changes test code, and a code diff needs reviewers and an envelope; minors and patches do not (DEC-0213). Nothing to delete. Simplified: one bump across all workspaces in one PR, no per-package split. Accelerated: the dependabot branch already resolved the lockfile, so start from its version set. Automated: nothing new; the existing gate chain is the check.

1. Read the vitest 5 changelog and migration notes before editing.
2. Bump `vitest` (and any `@vitest/*` companion such as the coverage provider) to 5.0.3 in every workspace package.json that declares `^4.1.11`; regenerate `pnpm-lock.yaml` with `pnpm install` under nvm Node 22.23.2 (never with install scripts disabled).
3. Fix every test or config break that the migration causes (vitest config, mock APIs, coverage provider options, reporters).
4. Run the full chain: `pnpm build && pnpm test && pnpm lint && pnpm format:check`.

## Acceptance Criteria

- [ ] AC-1: `package.json` files and `pnpm-lock.yaml` updated to vitest 5.0.3 (and matching companions).
- [ ] AC-2: `pnpm build && pnpm test && pnpm lint && pnpm format:check` is green.
- [ ] AC-3: the PR body lists each vitest 5 behaviour change that needed a test or config edit, with the file touched.
- [ ] AC-4: the PR body notes that dependabot #1446 is superseded; the operator closes it (agents never close PRs).
- [ ] AC-5: reviewers run and the attestation envelope is signed as for any code PR.

## Out of scope

`forge-data-room-kit` (pinned 3.2.7); other dependency bumps; any test rewrite that is not forced by the migration.
