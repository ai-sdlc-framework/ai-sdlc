---
id: AISDLC-1291
title: 'Untrusted PR gate sandbox gets pnpm and dependencies from a fetch container before the no-network run container'
status: Done
assignee: []
created_date: '2026-11-16'
labels:
  - pipeline-cli
  - untrusted-pr-gate
  - bug
dependencies: []
references:
  - pipeline-cli/src/pipeline/sandbox-runner.ts
  - pipeline-cli/src/pipeline/sandbox-runner.test.ts
  - pipeline-cli/src/cli/ucvg.ts
  - pipeline-cli/src/cli/ucvg.test.ts
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/__tests__/untrusted-pr-gate.test.mjs
  - docs/concepts/untrusted-contributor-verification.md
priority: high
dispatchable: true
dispatchableReason: 'Observed on the first end-to-end gate run (fork PR #2634, run 43939762163, 2026-11-16): the base suite and the head suite both ended with `sh: 1: pnpm: not found`, so `upstreamSuitePassed` and `newTestsPassed` were false, two reviewers voted no for that reason alone and stage 4 refused the report. The operator chose the design (fetch container, then run container) through the decision rubric on 2026-11-16.'
---

## Description

**Gap.** No outsider PR can pass the gate, whatever it contains.

- The sandbox container is the stock `node:22-bookworm` image pinned by digest (`DEFAULT_SANDBOX_IMAGE` in `pipeline-cli/src/pipeline/sandbox-runner.ts`). It has `node`, `npm` and `corepack`, and no `pnpm`.
- The container runs with `--network=none`, a read-only root and one mount: the base tree exported by `git archive`, without `node_modules`. No package store is mounted.
- The script built by `buildDifferentialTestScript` runs `pnpm install --frozen-lockfile --offline || pnpm install --frozen-lockfile || true`, so a failed install is swallowed, then `pnpm test || npm test`. Both suites fail with `pnpm: not found`.
- The workspace is a tmpfs mounted `noexec`, so a native binary (esbuild and similar) placed there by an install could not run even with a network.
- The reviewers receive "base suite failed, head suite failed, coverage 0" and vote no. Three model calls are spent on a run that cannot pass.

**Fact that narrows the design.** `**/package.json` and every lockfile are in `protectedPaths` of `.ai-sdlc/untrusted-pr-gate.yaml`, so stage 1 blocks any outsider PR that changes dependencies. The dependencies of the head tree are always those of the base tree, which is a commit of `main`.

**Decision (operator, decision rubric, 2026-11-16).** Options weighed: (A) a fetch container with network installs the dependencies of the base tree, then the existing hardened container runs without network and mounts the result read-only; (B) a prebuilt gate image in a registry holding pnpm and the dependencies; (C) one container that installs with network and has its network cut before the diff is applied; (D) drop the sandbox suite and read the fork PR's CI result. Option A was chosen. The strongest case against it is that a prebuilt image is the usual answer, installs once and is reviewed once, while A installs on every run and runs dependency lifecycle scripts with network each time. A was kept because those scripts belong to `main`'s own dependencies, the same ones trusted CI runs on every push; an image one lockfile behind `main` fails every outsider PR silently, which is the defect being fixed; and an image must be built and hosted by every adopter. C loosens the container that runs untrusted code. D reverses RFC-0043 stage 2.

**Shape.** Two containers per gate run. The fetch container sees only the base tree and has network. The run container is the one that exists today, with every restriction it has today, and receives the prepared tree read-only.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must the suites run inside the sandbox at all? Yes, RFC-0043 stage 2 requires the base-versus-head comparison and the operator kept it (option D rejected). Must the install run in the hardened container? No: it handles only `main`'s tree. 2. Deleted: both install blocks of the in-container script and their `|| true`. 3. Simplified or optimised: one install per run, on the base tree, reused for the head suite. 4. Accelerated: a fetch failure stops the run before any model call. 5. Automated: tests on the docker arguments of both containers and on the failure path.

- **Fetch container.** Same pinned image as the run container. Network on. Input: a copy of the base tree only. It never receives the PR diff (`SANDBOX_PR_DIFF_B64`), the fixture variable, any secret or the inference proxy host entry. It activates the pnpm version named by `packageManager` in the base tree's `package.json` (corepack ships in the image) and runs `pnpm install --frozen-lockfile`. Its output is the base tree with dependencies plus the pnpm executable, in a directory created by our own `mkdtemp`. For `package-lock.json` and `yarn.lock` repositories it runs the matching frozen install.
- **Run container.** Every argument it has today stays: `--network=none`, `--cap-drop=ALL`, `--read-only`, the seccomp profile, `no-new-privileges`, user `65534:65534`, the pids, memory and cpu limits. It mounts the fetch output read-only in place of the bare base tree. The in-container script no longer installs anything; it runs the base suite, applies the diff, runs the head suite.
- **`noexec` workspace.** Native binaries of dependencies must execute from the read-only mount, not from the `noexec` tmpfs. Keep `noexec` on the workspace. If the head suite cannot be made to run with it, do not remove it: stop and report the exact failure in the verdict notes.
- **Fetch failure.** A non-zero install is a gate environment failure, not a test failure. The run stops, no reviewer is called, no report with `upstreamSuitePassed: false` is written for it, and the step fails with a message that names the fetch phase. The existing watchdog then posts the failure status.
- **Docs.** `docs/concepts/untrusted-contributor-verification.md` describes the two containers and what each one can reach.

Out of scope: Python and Go suites (AISDLC-1293); the content of `.ai-sdlc/untrusted-pr-gate.yaml`; the reviewer prompts; the stage 4 rules; caching the fetch output between runs.

## Acceptance Criteria

- [ ] #1 The docker arguments of the fetch container contain no `-e SANDBOX_PR_DIFF_B64`, no `-e SANDBOX_FIXTURE_B64`, no `--add-host` and no secret; a test asserts each absence.
- [ ] #2 The docker arguments of the run container still contain `--network=none`, `--cap-drop=ALL`, `--read-only`, the seccomp option, `no-new-privileges`, `--user 65534:65534` and `noexec` on the workspace tmpfs; no existing assertion on them is removed or weakened.
- [ ] #3 The run container mounts the fetch output read-only, and the in-container script contains no `install` command and no `|| true`; tests cover both.
- [ ] #4 The fetch container uses the pnpm version read from `packageManager` of the base tree; a test covers a repository with that field and one without it.
- [ ] #5 When the fetch install exits non-zero, no reviewer runs, no unsigned report is written and the error names the fetch phase; a test covers it.
- [ ] #6 With `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1` and Docker available, a fixture repository with a pnpm lockfile, one dependency that ships a native binary and one passing test yields `upstreamSuitePassed: true` and `newTestsPassed: true` for a diff that adds a passing test.
- [ ] #7 The diff of `.github/workflows/untrusted-pr-gate.yml`, if any, changes no trigger, permission, `if:` condition, secret or environment; the PR body states this.
- [ ] #8 `docs/concepts/untrusted-contributor-verification.md` describes the fetch container and the run container.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
