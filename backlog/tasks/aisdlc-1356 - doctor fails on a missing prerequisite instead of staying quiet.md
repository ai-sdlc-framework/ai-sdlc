---
id: AISDLC-1356
title: 'Doctor fails on a missing prerequisite instead of staying quiet'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - doctor
  - adopter
  - bootstrap
dependencies:
  - AISDLC-1351
  - AISDLC-1352
references:
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor-checks.test.ts
  - orchestrator/src/cli/commands/doctor-checks-dispatch-board.test.ts
  - ai-sdlc-plugin/commands/doctor.md
  - docs/operations/doctor.md
  - pipeline-cli/src/hierarchy/node-pin.ts
  - pipeline-cli/src/hierarchy/reconcile-scheduler.ts
  - pipeline-cli/src/config-manifest/manifest.ts
priority: high
dispatchable: true
dispatchableReason: 'Bounded to doctor-checks.ts, its two test files and two doc lines; the three quiet checks and six new checks are listed one by one.'
---

## Description

**Gap.** On a repository that has just been set up, `doctor` prints a clean report while three checks have looked at nothing and six prerequisites are never looked at. An operator who runs `doctor` to learn whether the setup works reads "no problem" when the answer is "not checked".

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running automatically; anything not working says so loudly.

**Cause (read from the source on main).** Every line below was read on the current checkout; none was reproduced on an adopter repository.

- `hierarchy-module` returns no result when `.ai-sdlc/dispatch/hierarchy.json` is missing (`orchestrator/src/cli/commands/doctor-checks.ts:1478`), when it does not parse, or when it has no sessions array. It also returns no result when every dispatch host is healthy (`doctor-checks.ts:1504`), so a pass is never printed.
- `dispatch-board` returns no result when `.ai-sdlc/dispatch` is missing or the adapter has no `listFiles` (`doctor-checks.ts:1842`).
- `stale-repo-build` returns no result when `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh` is missing (`doctor-checks.ts:1728`), which is every adopter repository, and again when the build is fresh (`doctor-checks.ts:1736`).
- No check runs `gh auth status`. `checkCiQueue` calls `gh` and is quiet when it is unauthenticated (`doctor-checks.ts:1429-1445`).
- No check names `backlog/tasks/`, the webhook secret (`AI_SDLC_WEBHOOK_SECRET`) or the recorded feed in `webhook.json`, the reconcile scheduler pid in `reconcile-scheduler.json` (`pipeline-cli/src/hierarchy/reconcile-scheduler.ts:18`, `:58-62`), or the Node version `up` needs (`.nvmrc` installed under nvm, `pipeline-cli/src/hierarchy/up.ts:625-628`, `pipeline-cli/src/hierarchy/node-pin.ts:43`).
- The review-config claim: `ai-sdlc-plugin/commands/doctor.md:116-118` says `--fix` scaffolds a "reviewer set". The manifest has four entries, `review-policy`, `agent-role`, `pipeline` and `workflow` (`pipeline-cli/src/config-manifest/manifest.ts:121-162`), and none writes `.ai-sdlc/review-config.yaml`. The code is the manifest; the doc is the part that is wrong. A repository without that file gets the built-in default selection (read from the base branch, `pipeline-cli/src/steps/reviewer-set.ts:188-199`).

**Shape.** Every check in the registry returns at least one result for every input, including no input. Absent input is classified per check, as below. Six new checks cover the prerequisites. The doc line matches the manifest.

Per check, what absent input means:

- `hierarchy-module`, no roster: "not set up yet", severity `warn`, remediation `cli-hierarchy up`. An unreadable roster file is `fail`. A roster with no running dispatch session is `warn`. All hosts healthy is a `pass`.
- `dispatch-board`, no board directory: "not set up yet", `warn`, remediation `cli-hierarchy up` (it creates the board). A missing `listFiles` adapter is a `warn` that says the board was not read.
- `stale-repo-build`, no resolve script: this repository uses the installed CLI, so there is nothing to check. It is a `pass` whose title says "not applicable: installed pipeline-cli is used". A fresh build is a `pass`.

New checks:

- `gh-auth`: `gh auth status` exits 0, else `fail` with `gh auth login`. Agents cannot open a pull request without it.
- `backlog-tasks`: `backlog/tasks/` exists, else `warn` with the one-line fix; `--fix` creates it.
- `webhook-config`: secret set and `webhook.json` records a feed, else `warn` naming what is missing and the command. Without a secret the board polls only, which is a valid mode, so it is never `fail`.
- `scheduler-alive`: the recorded pid is alive, else `warn` with `cli-hierarchy up`.
- `node-version`: when `.nvmrc` names a version, it is installed under nvm (the rule `up` applies), else `fail` with `nvm install <version>`; and the running Node is at or above the floor named in the planner reading below.
- `review-config`: pass naming whether `.ai-sdlc/review-config.yaml` is present or the built-in default applies.

**Control.** Tightens an operator-visible control: doctor reports more states and fails on a missing `gh` login or an uninstalled `.nvmrc` Node. It loosens nothing. No gate reads doctor output.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should a check that finds nothing to inspect print nothing? No; the operator cannot tell it from a check that was never run. 2. Deleted: the early `return []` in the three checks and the unreviewed "reviewer set" claim in the plugin doc. 3. Simplified: one rule for the registry, "at least one result per check", enforced by one test over the registry instead of per-check tests of silence. 4. Accelerated: the new checks read files and one `gh` call; no network beyond `gh auth status`. 5. Automated: the registry test fails when a future check returns an empty list on empty input.

- Replace the five quiet returns above with the named results in **Shape**.
- Add the six checks to the registry (`doctor-checks.ts`, next to `checkCiQueue`) with a catalogue line each in `docs/operations/doctor.md`.
- Add the `backlog-tasks` fix to the `--fix` subset.
- Change `ai-sdlc-plugin/commands/doctor.md:116-118` to name the entries the manifest scaffolds (review policy, agent role) and say the pipeline and workflow entries follow the manifest.
- Add a registry test that runs every check against an empty project directory and fails when any returns no result.
- Tests in the two test files listed in the references.

**Planner reading (class (a), no control effect; the operator may overrule).** The Node floor for adopters. The repository root sets `engines.node` to `>=22.22.1` (`package.json:8`), but `pipeline-cli` declares none, and `up` pins only when `.nvmrc` exists. The check invents no floor: it reads `engines.node` of the installed `pipeline-cli` package and warns when the running Node is below it; when the package declares none, the result is a pass that says no floor is declared. The `.nvmrc` part is as described above.

**Planner reading (class (a), no control effect; the operator may overrule).** `.ai-sdlc/review-config.yaml` is not scaffolded; the `review-config` check names the default in effect. This task does not add a manifest entry.

Out of scope: the merge-settings check (AISDLC-1351), the required-check comparison (AISDLC-1352), the old verify-attestation workflow flag (AISDLC-1353), the up and status wording (AISDLC-1357), the dispatch heartbeat state (AISDLC-1358, which also edits `checkHierarchyModule`; whichever lands second rebases).

## Acceptance Criteria

- [ ] #1 A test runs `hierarchy-module` with no `hierarchy.json` and gets one `warn` result naming `cli-hierarchy up`; with an unparseable file it gets a `fail`; with all hosts healthy it gets a `pass`.
- [ ] #2 A test runs `dispatch-board` with no board directory and gets a `warn` result naming `cli-hierarchy up`, and with a missing `listFiles` adapter a `warn` saying the board was not read.
- [ ] #3 A test runs `stale-repo-build` with no resolve script and gets a `pass` whose title says it does not apply, and with a fresh build a `pass`.
- [ ] #4 A test shows `gh-auth` is `fail` when `gh auth status` exits non-zero and `pass` when it exits 0.
- [ ] #5 A test shows `backlog-tasks` is `warn` when `backlog/tasks/` is missing, and `--fix` creates the directory.
- [ ] #6 A test shows `webhook-config` is `warn` with no secret, `warn` with a secret and no recorded feed, and `pass` with both.
- [ ] #7 A test shows `scheduler-alive` is `warn` with no record or a dead pid and `pass` with a live pid.
- [ ] #8 A test shows `node-version` is `fail` when `.nvmrc` names a Node that is not installed under nvm and `pass` when it is.
- [ ] #9 A registry test runs every check against an empty project directory and fails when any check returns no result.
- [ ] #10 `ai-sdlc-plugin/commands/doctor.md` no longer names a reviewer set among the `--fix` entries, and a test or grep check ties the entry names in that sentence to the manifest ids.
- [ ] #11 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
