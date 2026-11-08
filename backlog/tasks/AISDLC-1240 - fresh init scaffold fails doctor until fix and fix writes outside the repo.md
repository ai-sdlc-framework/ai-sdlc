---
id: AISDLC-1240
title: 'ai-sdlc init --yes leaves a fresh repo failing doctor (missing review-policy.md) until doctor --fix, and --fix writes into the plugin cache'
status: In Progress
assignee: []
created_date: '2026-11-08'
labels:
  - orchestrator
  - onboarding
  - doctor
  - bug
dependencies: []
references:
  - pipeline-cli/src/config-manifest/manifest.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - docs/getting-started/install-agent-brief.md
  - scripts/smoke-install-brief.mjs
priority: medium
dispatchable: true
dispatchableReason: 'Filed by the planner on operator order 2026-11-08 from the first real passing run of scripts/smoke-install-brief.mjs (AISDLC-1236 AC #2, PR #2556): a fresh install needs a repair step before the first doctor passes, and that repair edits a file outside the repository.'
---

## Description

**Observed 2026-11-08 (operator machine, AISDLC-1236 AC #2 run, plugin and CLI 0.40.0).** In a fresh temp repo the brief ran `ai-sdlc init --yes`, then `ai-sdlc doctor`. The first doctor run reported a **failure** for a missing `.ai-sdlc/review-policy.md`. `ai-sdlc doctor --fix` then scaffolded `review-policy.md` and `workflow.yaml`, after which doctor passed (25 pass, 2 warn, 0 fail). The same `--fix` also copied `plugin.json` into the plugin cache's `.claude-plugin/` folder (`manifests-agree` repair), a write outside the repository that the installing agent flagged.

Two problems:
1. `pipeline-cli/src/config-manifest/manifest.ts` lists `review-policy` and `workflow` as manifest entries, so `init --yes` should write them. Either the published 0.40.0 `init` skips optional entries under `--yes`, or the manifest at that version lacks them, or `init` wrote them somewhere doctor does not look. Reproduce with the smoke script (needs a Claude Code login; the reproduction can instead run `ai-sdlc init --yes` plus `ai-sdlc doctor` in a temp dir without `claude -p`) and fix so a fresh `init --yes` passes `config-manifest` and `workflow-document` on the first doctor run.
2. `doctor --fix` must not write outside the repository without saying so. The `manifests-agree` repair that copies into `~/.claude/plugins/cache/...` should either be skipped under `--fix` with a printed instruction, or print the absolute path it is about to write and require a second flag.

## Fix

**Five-step review (requirements first).**
1. Question: must a fresh install pass doctor with zero repair steps? Yes: the brief promises "when doctor passes, commit", and AC-4 of AISDLC-1179 counts a passing first run as the proof the brief works.
2. Delete: if `init --yes` has a separate "optional entries" prompt path, remove the distinction: every manifest entry doctor requires is written by `init`.
3. Simplify: `init --yes` writes every required manifest entry; `doctor --fix` repairs only paths under the repository root and prints a one-line instruction for anything else.
4. Accelerate: none.
5. Automate: an integration test runs `init --yes` then the doctor checks `config-manifest` and `workflow-document` against a temp dir and asserts PASS; a unit test asserts `--fix` refuses a target outside the repo root.

## Acceptance Criteria

- [ ] AC-1: in a temp git repo, `ai-sdlc init --yes` followed by `ai-sdlc doctor` reports no FAIL for `config-manifest` or `workflow-document`; test added.
- [ ] AC-2: `ai-sdlc doctor --fix` never writes outside the repository root; for the `manifests-agree` repair it prints the path and the command to run instead; test added.
- [ ] AC-3: the PR body names the root cause of observation 1 (which of the three hypotheses held).
- [ ] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
