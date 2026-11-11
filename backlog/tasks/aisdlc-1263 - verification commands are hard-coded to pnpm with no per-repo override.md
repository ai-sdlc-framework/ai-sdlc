---
id: AISDLC-1263
title: '`next-step` hard-codes `pnpm build/test/lint/format:check` as the verification commands; non-Node adopters need a `package.json` shim. Add a per-repo override.'
status: To Do
assignee: []
created_date: '2026-11-11'
labels:
  - pipeline-cli
  - next-step
  - adopter
  - feature
dependencies: []
references:
  - pipeline-cli/src/steps/verify-defaults.ts
  - pipeline-cli/src/steps/05-build-dev-prompt.ts
  - pipeline-cli/src/steps/10-finalize.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - docs/operations/init.md
priority: medium
dispatchable: true
dispatchableReason: 'Adopter-reported (issue #2622, Python repo with uv.lock). Verified: verify-defaults.ts, the dev prompt (Step 5), finalize (Step 10) and push (Step 11) all carry the pnpm commands literally.'
---

## Description

**Gap (issue #2622, observation 4).** The developer prompt tells the subagent to run `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check`; Step 10 reports them by name and Step 11 reruns them. A Python or Go adopter must add a `package.json` whose scripts shell out to their toolchain. `.ai-sdlc/` already holds per-repo configuration, so the commands belong there.

**Shape.** A `verification:` block in `.ai-sdlc/pipeline.yaml` (or the file `init` already writes) lists the commands by key (`build`, `test`, `lint`, `format`); a missing block keeps today's pnpm defaults; a missing key skips that step and says so in the Step 10 summary. Steps 5, 10 and 11 read the block through `verify-defaults.ts`, which becomes the single source. `init` offers the block with detected defaults (`package.json` -> pnpm, `pyproject.toml` -> `uv run pytest` and friends).

## Fix

**Five-step review.**
1. Requirement questioned: must every repo run four named steps? The four keys stay as the contract the reviewers and the PR body rely on; what runs under each key is the adopter's.
2. Deleted: the three literal copies of the pnpm list (Steps 5, 10, 11).
3. Simplified: one resolver, one config block.
4. Accelerated: non-Node adopters skip the shim.
5. Automated: `init` detection; tests per toolchain fixture.

## Acceptance Criteria

- [ ] AC-1: `verify-defaults.ts` exports a resolver that reads the `verification` block and falls back to the pnpm defaults when absent; tests for both.
- [ ] AC-2: Steps 5, 10 and 11 use the resolver and contain no literal `pnpm` verification command; grep test.
- [ ] AC-3: an omitted key skips the step and Step 10 prints `skipped (not configured)` for it; test.
- [ ] AC-4: `ai-sdlc init` writes the block with detected defaults for `package.json` and `pyproject.toml` fixtures; test.
- [ ] AC-5: `docs/operations/init.md` documents the block and the defaults.
- [ ] AC-6: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
