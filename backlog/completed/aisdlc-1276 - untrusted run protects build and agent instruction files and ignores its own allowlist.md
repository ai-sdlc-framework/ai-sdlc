---
id: AISDLC-1276
title: 'Untrusted run: build and agent-instruction files are protected, and the run cannot widen its own write allowlist'
status: Done
assignee: []
created_date: '2026-11-13'
labels:
  - plugin
  - hooks
  - security
  - untrusted-run
dependencies:
  - AISDLC-1275
references:
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - ai-sdlc-plugin/hooks/lib/governance-resolver.test.mjs
  - pipeline-cli/src/runtime/untrusted-env.ts
priority: high
dispatchable: true
dispatchableReason: 'Audit finding F4 of 2026-11-13, verified by the planner at main 09915448. DEC-0403 (staged disclosure) authorizes filing once the F1 author gate (AISDLC-1269, #2655) has landed; it has. Depends on AISDLC-1275, which introduces the shared protected list and its parity test. Tightens a control: class (a).'
---

## Description

**Gap.** Three holes in what an untrusted run (an issue-sourced `/ai-sdlc execute`) may write, all in `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`:

1. **The protected list is too short.** `UNTRUSTED_PROTECTED` (lines 302-313) covers `.ai-sdlc`, `.github/workflows`, `.claude`, `.husky`, `ai-sdlc-plugin/hooks` and three `.git` entries. It leaves writable every file that runs code or instructs an agent on the maintainer's machine or in CI: `package.json` at any depth (scripts and lifecycle hooks), the lockfile, `.npmrc`, `pnpm-workspace.yaml`, `scripts/**`, `CLAUDE.md` at any depth and `.mcp.json`. The resulting PR is a branch of the same repository, so it passes the same-repo test that guards secret-bearing CI jobs (`.github/workflows/ai-sdlc-gate.yml:374`) and never meets the fork gate.
2. **The run can widen its own allowlist.** `loadActiveTaskFile` (1097-1125) reads `permittedExternalPaths` from the task file under `backlog/tasks/` in the worktree. For an issue-sourced run that file is synthetic, written by Step 4, and `backlog/` is not protected, so the agent can add any outside path to it and then write there (670-676).
3. **Trust is decided from the working directory only.** `isUntrustedRun(process.env, toolCwd || process.cwd())` (line 300; marker walk in `lib/governance-resolver.js:541-627`) never looks at the path being written. A write aimed at another checkout is judged by where the command ran.

**Shape.** In an untrusted run the protected list covers code-execution and agent-instruction files, `permittedExternalPaths` is not honoured at all, and a write outside the run's own worktree is refused.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: an issue-sourced run exists to change product code and tests; none of the files above is needed for that, and a real need goes through a maintainer task. 2. Deleted: `permittedExternalPaths` and the outside-home scratch exemption for untrusted runs (nothing replaces them; an issue has no sibling repository). 3. Simplified or optimised: one rule for writes, "inside this worktree and not protected", in place of per-exemption logic. 4. Accelerated: n/a. 5. Automated: hook tests per path and per exemption.

- Extend the untrusted protected list with: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `CLAUDE.md`, `.mcp.json` (matched by basename at any depth) and `scripts/` (root). Update the shared list from AISDLC-1275 in the same change so the parity test stays green and the pre-push check refuses the same paths.
- In an untrusted run, skip `loadPermittedExternalPaths` and the scratch exemption: a Write, Edit or MultiEdit whose resolved target is outside the worktree of the run is denied. The session temp directory stays writable.
- The denial message names the path and says a maintainer task is the route for such a change.
- Out of scope, stated so it is not assumed fixed: a Bash command can still write outside the worktree; that is contained by AISDLC-1277, and committed changes are caught by AISDLC-1275.

## Acceptance Criteria

- [ ] #1 In an untrusted run, Write and Edit to each of `package.json`, `orchestrator/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `CLAUDE.md`, `docs/CLAUDE.md`, `.mcp.json` and `scripts/x.sh` are denied; one test per path.
- [ ] #2 In an untrusted run, a task file that lists `permittedExternalPaths` grants nothing: a write to a listed outside path is denied. A test edits the synthetic task file first, then attempts the write.
- [ ] #3 In an untrusted run, a write to a path outside the run's worktree is denied even when the target sits in another checkout with no marker.
- [ ] #4 In a trusted run every case above behaves as today; existing tests pass unchanged.
- [ ] #5 The parity test from AISDLC-1275 passes with the extended list, and the pre-push check refuses a commit that changes `package.json`.
- [ ] #6 The denial message for these paths names the path and the maintainer-task route (`governance-refusal-messages.test.mjs` covers it).
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
