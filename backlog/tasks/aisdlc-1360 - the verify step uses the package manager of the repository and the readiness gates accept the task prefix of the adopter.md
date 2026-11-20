---
id: AISDLC-1360
title: 'The verify step uses the package manager of the repository, and the readiness gates accept the task prefix of the adopter'
status: In Progress
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - adopter
  - bootstrap
  - dor
dependencies: []
references:
  - pipeline-cli/src/steps/verify-defaults.ts
  - pipeline-cli/src/steps/verification-config.ts
  - pipeline-cli/src/steps/verification-config.test.ts
  - pipeline-cli/src/steps/verify-commands.ts
  - pipeline-cli/src/steps/verify-commands.test.ts
  - pipeline-cli/src/steps/00-5-sync-parent.ts
  - pipeline-cli/src/dor/gates/gate-3-references.ts
  - pipeline-cli/src/dor/gates/gate-3-references.test.ts
  - pipeline-cli/src/dor/gates/gate-5-surface.ts
  - pipeline-cli/src/dor/gates/gate-5-surface.test.ts
  - pipeline-cli/src/dor/gates/gate-7-deps.ts
  - pipeline-cli/src/dor/gates/gate-7-deps.test.ts
  - pipeline-cli/src/dor/resolvers/file-existence.ts
  - pipeline-cli/src/dor/resolvers/file-existence.test.ts
  - docs/operations/init.md
  - backlog/config.yml
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to the verify defaults and the framework-only expansion in the verify step, plus the four readiness spots that hard-code the task prefix; 14 files with tests.'
---

## Description

**Gap.** In an adopter repository the verify step runs `pnpm` commands whatever the repository uses, and adds framework-only commands on some rounds. The readiness gates (the Definition-of-Ready checks on a task) only recognise task ids that start with `AISDLC-`, so a task of an adopter with another prefix gets wrong readiness results.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running automatically; anything not working says so loudly.

This task is the half of the original scope that fits 15 files. The scaffolded gate workflow's pnpm-only jobs are a follow-up, listed under Out of scope.

**Cause (read from the source on main).** Each line below was read on the current checkout. The effects on an adopter are inferred from the code; none was run on an adopter repository (unverified).

Verify step:

- The default commands are `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` (`pipeline-cli/src/steps/verify-defaults.ts:9-14`). A repository with no `verification:` block gets them (`verify-defaults.ts:36-38`).
- `detectVerificationDefaults` returns the pnpm defaults for any `package.json`, whatever the lockfile, `uv` commands for `pyproject.toml`, and nothing otherwise (`verify-defaults.ts:53-66`). `init` writes `.ai-sdlc/verification.yaml` from that result and writes nothing when it returns none (`pipeline-cli/src/steps/verification-config.ts:35-44`). An npm, yarn or bun repository therefore gets pnpm commands, and a repository with neither file gets pnpm defaults at run time.
- `ROOT_TEST_CHAIN_REST` is a chain of this repository's own scripts (`pnpm test:gates && pnpm rfc:check && ...`, `pipeline-cli/src/steps/verify-commands.ts:147-148`), and `patchGateCommand` runs `scripts/check-pr-patch-coverage.mjs` (`verify-commands.ts:151-153`). `expandVerifyCommands` adds both when the command list holds the literal `pnpm test` and either the coverage package list is non-empty or a narrowed round returned affected packages (`verify-commands.ts:162-183`).
- `coveragePackages` runs `scripts/list-coverage-packages.mjs` and returns an empty list on any failure, including a missing script (`verify-commands.ts:260-273`). In an adopter that makes the first round safe. On a later, narrowed round `affectedPackages` asks `pnpm ls -r` (`verify-commands.ts:224-227`), and in a pnpm adopter that returns packages, so the framework-only chain and patch gate are added and fail on a missing script (inferred, unverified). The call site is `verify-commands.ts:302-307`.

Readiness gates:

- The adopter's prefix is configured in `backlog/config.yml` as `task_prefix` (this repository: `backlog/config.yml:14`, `'AISDLC'`). A reader already exists: `readConfiguredTaskPrefix(workDir)` returns the lower-case prefix or `null` (`pipeline-cli/src/steps/00-5-sync-parent.ts:93-104`).
- Four places hard-code `AISDLC-`: `pipeline-cli/src/dor/gates/gate-3-references.ts:45` (`TASK_ID_RE`, used at `:94` to find pending upstream tasks), `pipeline-cli/src/dor/gates/gate-5-surface.ts:45` (the `aisdlc-ref` surface pattern), `pipeline-cli/src/dor/gates/gate-7-deps.ts:50` (the tracked-work-id pattern that the dependency phrases need) and `pipeline-cli/src/dor/resolvers/file-existence.ts:20` (`AISDLC_RE`, used at `:29` and `:57`). With another prefix, a reference such as `after ACS-12 ships` is not read as a task id (inferred).
- Gate 3 has `workDir` through `Gate3Opts` (`gate-3-references.ts:24-26`) and the resolver through `ResolverOpts.workDir` (`pipeline-cli/src/dor/types.ts:250-252`). Gates 5 and 7 take only the issue input (`gate-5-surface.ts:103`, `gate-7-deps.ts:231`), which carries `workDir` in gate 3's use (`input.workDir`, `gate-3-references.ts:25`).

Package manager detection, facts only: the lockfile names are `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` and `bun.lockb` or `bun.lock`; `package.json` may also carry a `packageManager` field. The repository already lists these lockfile names for another purpose (`pipeline-cli/src/pipeline/ast-gate.ts:143-145`) but has no detector.

**Shape.** `detectVerificationDefaults` picks the commands of the package manager the repository uses (lockfile first, then the `packageManager` field, pnpm when neither says). The framework-only chain and patch gate are added only in a repository that has the framework's own scripts. The readiness gates build their task-id patterns from the configured prefix, per `workDir`.

**Control.** Does not loosen a control. The verify step still runs the same four steps and the readiness gates still apply the same rules; only which command spells a step, and which id shape counts as a task id, change. Today's behaviour is kept in this repository (`pnpm`, `AISDLC`).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should the framework's own chain ever run in an adopter? No. 2. Deleted: the swallowed failure of a missing script (an explicit presence test replaces it) and the four literal prefixes. 3. Simplified: reuse `readConfiguredTaskPrefix` and one pattern builder for the four spots instead of four copies; one lockfile table for the detector. 4. Accelerated: no new I/O beyond one `existsSync` per lockfile and one config read per evaluation. 5. Automated: tests run the gates with prefix `ACS` and the verify step in npm and yarn fixtures.

- A new function `detectPackageManager(exists, readText)` in `verify-defaults.ts` returns `pnpm`, `npm`, `yarn` or `bun`. Both arguments are functions passed in, so it does no I/O of its own; `readText` is optional and is used only to read the `packageManager` field of `package.json` when no lockfile is present. `detectVerificationDefaults` takes the same optional `readText`, calls `detectPackageManager` and returns the table below. `scaffoldVerification` (`verification-config.ts:35-44`) passes a reader, and `verification-config.ts` re-exports `detectPackageManager`, because the orchestrator reaches pipeline-cli only through the `./verification` export and AISDLC-1362 needs the name at `init` time.
- `expandVerifyCommands` and its call site run only when `scripts/list-coverage-packages.mjs` exists in the working directory. The silent `catch` in `coveragePackages` stays for a failing script, but a missing script is no longer treated as a failure.
- A shared function builds the task-id source for a `workDir` (`readConfiguredTaskPrefix`, escaped, with the fallback below) and the four spots call it.
- `docs/operations/init.md` (lines 197-207, the verification block and its defaults) names the lockfile rule.
- Tests in the test files listed in the references.

Table for the detector (a proposal for the spelling; any command that runs the named script is acceptable): pnpm unchanged; npm `npm run build`, `npm test`, `npm run lint`, `npm run format:check`; yarn `yarn build`, `yarn test`, `yarn lint`, `yarn format:check`; bun `bun run build`, `bun run test`, `bun run lint`, `bun run format:check`.

**Planner reading (class (a), no control effect; the operator may overrule).** When `backlog/config.yml` has no `task_prefix`, the readiness gates keep `AISDLC`, the same fallback the merge helper uses, so nothing changes for a repository without the key. The fallback is one constant.

**Planner reading (class (a), no control effect; the operator may overrule).** What the verify step does for a repository with neither `package.json` nor `pyproject.toml`, and for a `package.json` with no `lint` or `format:check` script. Today the pnpm defaults run and fail. It keeps failing loudly (no silent skip of a step). This task does not change it.

Out of scope: the scaffolded gate workflow jobs, which are pnpm-only (`orchestrator/src/cli/commands/init-templates.ts:84-131`) and need the template changes of AISDLC-1353 first. The follow-up task AISDLC-1362 calls `detectPackageManager` at `init` time, writes setup and install steps for the detected manager, and updates the init note at `docs/operations/init.md:189-193`. It touches `init-templates.ts`, `init-features.ts`, their tests and the init doc, which would take this task past 15 files. Also out of scope: the repository-relative bins (AISDLC-1359).

## Acceptance Criteria

- [ ] #1 A test shows `detectVerificationDefaults` returns the npm commands for a `package-lock.json`, the yarn commands for a `yarn.lock`, the bun commands for a `bun.lockb`, and the pnpm commands for a `pnpm-lock.yaml`.
- [ ] #2 A test shows a `package.json` with no lockfile and `"packageManager": "yarn@4"` returns the yarn commands, and with neither returns the pnpm commands.
- [ ] #3 A test shows `pyproject.toml` still returns the `uv` commands and a directory with neither file still returns none.
- [ ] #4 A test shows `expandVerifyCommands` and its call site leave the commands unchanged, including on a narrowed round, when `scripts/list-coverage-packages.mjs` is absent.
- [ ] #5 A test shows this repository's layout (the script present) still expands the commands as before.
- [ ] #6 A test with `task_prefix: 'ACS'` shows gate 3 treats `ACS-12` as a task id (pending lookup), gate 5 counts it as a surface reference, gate 7 reads `after ACS-12 ships` as a tracked dependency, and the file-existence resolver resolves it against `backlog/tasks/` and `backlog/completed/`.
- [ ] #7 A test with `task_prefix: 'AISDLC'` shows the four spots behave exactly as before, and with no `task_prefix` they use the documented fallback.
- [ ] #8 A test shows a prefix with regular-expression characters is escaped, so it cannot change what the pattern matches.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
