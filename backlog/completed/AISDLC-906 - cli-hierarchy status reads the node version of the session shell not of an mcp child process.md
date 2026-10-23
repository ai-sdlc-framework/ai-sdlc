---
id: AISDLC-906
title: 'fix: cli-hierarchy status reads the Node version of the session shell, not of an MCP child process'
status: Done
assignee: []
created_date: '2026-10-15'
labels: [hierarchy, bug]
references: [pipeline-cli/src/hierarchy/node-pin.ts, pipeline-cli/src/hierarchy/status.ts, pipeline-cli/src/hierarchy/hierarchy.test.ts]
priority: medium
dispatchable: true
---

## Description

`cli-hierarchy status` printed `22.19.0 MISMATCH` for every roster session on 2026-10-14/15 and told the operator to relaunch them, after the sessions HAD been relaunched under the pinned Node 22.23.2. `paneNodeVersion` in `pipeline-cli/src/hierarchy/node-pin.ts` walks the pane's process tree and takes the first process whose executable path contains `/versions/node/vX.Y.Z/`; in every session that process was the `backlog` MCP server, a global install under the older Node, not the Claude session's own shell. The false MISMATCH repeated in every dispatch digest ("Node mismatch on planner, dispatch, alpha and beta ... needs a relaunch") and the planner had to explain it each time. The workaround (reinstall the global tool under the pinned Node) hides the bug instead of fixing it.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the version of "some Node process in the pane" says anything about the session. The pin protects the pipeline-cli and hooks the session runs, which execute under the pane shell's `PATH`; only that shell's `node` matters. 2. Deleted: the process-tree walk. 3. Simplified: resolve the version from the pane shell itself: read the pane's top-level shell pid, resolve `node` on that process's `PATH` (from its environment, `ps eww` or `/proc`-equivalent on darwin via the launch command recorded by `cli-hierarchy up`), and compare that binary's version; when `up` launched the pane with an explicit `--node` or `nvm use`, record the chosen version in the pane's launch metadata and read it back, no probing at all. 4. Accelerated: `status` stops emitting a MISMATCH that is false, so digests stop repeating it and no relaunch is ordered for nothing. 5. Automated: `ai-sdlc doctor`'s roster check reuses the same function, one source of truth.

## Acceptance Criteria

- [ ] `paneNodeVersion` (or its replacement) returns the version of the `node` the pane's own shell resolves, and ignores child processes such as MCP servers; a test with a fake process tree where the shell runs 22.23.2 and a child MCP server runs 22.19.0 reports 22.23.2 and no mismatch.
- [ ] When `cli-hierarchy up` launched the pane with a known Node version, `status` reads that recorded version instead of probing; test covers the recorded path.
- [ ] `status` prints MISMATCH only when the shell's Node differs from `.nvmrc`; the existing mismatch test still passes with a genuinely wrong shell version.
- [ ] `ai-sdlc doctor` uses the same function for its roster Node check (no second implementation).
- [ ] Task file moved to `backlog/completed/` in the PR.
