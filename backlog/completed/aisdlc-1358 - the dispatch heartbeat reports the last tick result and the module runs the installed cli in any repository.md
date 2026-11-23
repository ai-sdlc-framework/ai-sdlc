---
id: AISDLC-1358
title: 'The dispatch heartbeat reports the last tick result, and the module runs the installed CLI in any repository'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - adopter
  - bootstrap
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/mods/tests/hierarchy-dispatch.test.ts
  - pipeline-cli/src/hierarchy/module-health.ts
  - pipeline-cli/src/hierarchy/module-health.test.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
  - pipeline-cli/src/hierarchy/host-liveness.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor-checks.test.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: 'Bounded to the heartbeat state, one recorded bin directory that the module reads, and the three readers (up, status, doctor), with tests in the files listed.'
---

## Description

**Gap.** The dispatch host reports `loaded` before its tick has run, so `up`, `status` and `doctor` read healthy while every tick fails. The module also runs the three pipeline-cli bins by a path that exists only inside this repository, so in a repository that has the plugin installed the host tick can fail on every run.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running automatically; anything not working says so loudly.

**Cause (read from the source on main).** Each line below was read on the current checkout. Whether the paths resolve in the adopter repository is the contested point; it is settled below from the code, and not yet on an adopter checkout.

- **Heartbeat before the tick.** `tick` writes `{ state: 'loaded' }` first (`ai-sdlc-plugin/hooks/hierarchy/dispatch.ts:343-352`) and only then runs `cli-hierarchy tick` (`dispatch.ts:353`). A failed run adds a pane note and escalates once to the planner (`dispatch.ts:355-366`); the heartbeat stays `loaded` and is refreshed by the next tick's first line. `readModuleHealth` knows only `loaded`, `refused`, `absent` and `stale` (`pipeline-cli/src/hierarchy/module-health.ts:14`, `:117`), and doctor treats anything but `loaded` as `absent` (`orchestrator/src/cli/commands/doctor-checks.ts:1500`).
- **Repository-relative bins.** The module spells the bins as `pipeline-cli/bin/cli-hierarchy.mjs`, `cli-ci.mjs` and `cli-dispatch.mjs` (`dispatch.ts:26-28`) and `runCli` runs `node <that path>` through `p.runProcess` with no `cwd` argument (`dispatch.ts:191-200`). The port is `$.process.run([command, ...args])` (`ai-sdlc-plugin/hooks/hierarchy/register.tsx:133`).
- **What resolves it, searched for and not found.** There is no shim, symlink or `node_modules` lookup on this path. `init` and `setup` create no `pipeline-cli/` directory in an adopter repository (`grep` of `orchestrator/src/cli/commands/init*.ts` and `setup.ts` for `pipeline-cli/bin` finds nothing). `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh` is not called by the module; the dogfood topology it handles is the only one where `pipeline-cli/bin` exists in the working directory. The host working directory is the host's, not set by the module; the module's own root lookup assumes it is the repository (`dispatch.ts:104-117`, a child `node` run). So in an adopter repository the relative path names a file that does not exist, `node` exits 1, and `tick` takes the failure branch every 30 s. This is inferred from the code; it was not run on an adopter checkout (unverified).
- **What carries the board meanwhile.** The reconcile scheduler `up` starts runs from the installed bin directory (`pipeline-cli/src/hierarchy/reconcile-scheduler.ts:97-112` uses `deps.binPath`). When the host has missed three intervals and work is queued it runs `cli-hierarchy tick --by scheduler` from the same directory (`pipeline-cli/src/cli/dispatch.ts:610-625`; `pipeline-cli/src/hierarchy/host-liveness.ts:24`, `:92-115`), which is every 90 to 120 s. That matches the adopter's ticks about 90 s apart. It does not explain a `by host` label: `status` prints `by scheduler` for those ticks (`host-liveness.ts:37-44`, `pipeline-cli/src/hierarchy/dispatch-loop.ts:1297`). If the adopter's `status` really prints `by host`, some process runs a plain `cli-hierarchy tick` from a resolvable path, and the path part of this task is then not needed on that machine. Two commands settle it on the adopter: `ls pipeline-cli/bin` in the repository root, and `cli-hierarchy status` read twice, 40 s apart.
- **Other relative bins.** `pipeline-cli/src/cli/hierarchy.ts:762`, `:1454`, `:1531` and `pipeline-cli/src/orchestrator/reconcile.ts:621` are AISDLC-1359, not this task.

**Shape.** The heartbeat has a state for "the last tick returned no result", with the first line of the error. `loaded` is written only after a tick returned a result. `up` already waits for `loaded` and prints the reason when it does not come; `status` and `doctor` show the new state the same way. `up` records the directory it runs the bins from, in `<board>/handoff/cli-bin.json`, and the module runs the three bins from that directory. With no record, the module keeps the relative path, which is correct in this repository.

**Control.** Tightens a visibility control: a failing tick stops reading as healthy. It loosens nothing and changes no gate or permission. Running the installed bins in an adopter repository is the same code the commands already run.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must the heartbeat be written before the tick? No; it exists to say the tick works. 2. Deleted: the pre-tick `loaded` write and the module's own bin spelling. 3. Simplified: no new resolver in the module; `up` already knows which bins it runs and records that one directory, and the module reads it. 4. Accelerated: a failing tick reaches `up` inside its 60 s wait, not at the next `doctor`. 5. Automated: tests run the module with a working directory that has no `pipeline-cli/`.

- **Heartbeat.** Move the `loaded` write after the tick result is parsed (`dispatch.ts:343-352` to after `:366`). On a failed run write `{ state: 'failing', reason: <first line of stderr or stdout, 200 characters> }`. `refused` is unchanged.
- **Readers.** Add `failing` to `ModuleState` and `readModuleHealth` (`module-health.ts:14`, `:117`); keep the stale rule for `loaded` only. `formatModuleHealth` prints `failing: <reason>`. `assertDispatchModuleLoaded` already refuses anything not `loaded`, so `up` names it. Doctor's `hierarchy-module` check names `failing` and its reason (AISDLC-1356 changes the same function; whichever lands second rebases).
- **Bin directory.** `up` writes `<board>/handoff/cli-bin.json` with the bin directory it was started from (`deps.binPath`, the one the scheduler already uses). The module reads it with a short `node -e` run, as it already does for the board path (`dispatch.ts:119-121`), and builds the three bin paths from it. Absent or unreadable record: the relative paths stay.
- **Docs.** `docs/operations/cli-hierarchy.md` ('Module absent') lists `failing` and the record.
- **Tests.** In the test files listed in the references.

**Planner reading (class (a), no control effect; the operator may overrule).** Where the dispatch module finds the installed CLI when `up` is not the process that started it (for example a session restarted by hand). The record written by the last `up`; a stale record after a plugin update is covered because `up` rewrites it on every start. A lookup through `CLAUDE_PLUGIN_ROOT` in the module was not chosen, because the host may not set it (unverified).

Out of scope: the other repository-relative bins and hook texts (AISDLC-1359), the `up` and `status` lines for the scheduler and webhook (AISDLC-1357), the scheduler stall limit (AISDLC-1357).

## Acceptance Criteria

- [ ] #1 A test of the module with a failing `runProcess` writes no `loaded` record before the tick and writes `failing` with the first error line after it.
- [ ] #2 A test shows a tick that returns a result writes `loaded`, and a later failure replaces it with `failing`.
- [ ] #3 A test of the module run with a working directory that has no `pipeline-cli/` and a `cli-bin.json` record runs the three bins from the recorded directory and the tick succeeds.
- [ ] #4 A test shows that with no record the module still runs `pipeline-cli/bin/cli-hierarchy.mjs` (this repository).
- [ ] #5 A test shows `readModuleHealth` returns `failing` with its reason, and does not turn it `stale` or `absent`.
- [ ] #6 A test shows `up` with a `failing` host throws the module error naming `failing: <reason>` and the fix line.
- [ ] #7 A test shows `status` prints `failing: <reason>` in the MODULE column.
- [ ] #8 A test shows doctor `hierarchy-module` fails on `failing` and names the reason.
- [ ] #9 A test shows `up` writes `cli-bin.json` with the directory of the bin it runs from and rewrites it on a second `up`.
- [ ] #10 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
