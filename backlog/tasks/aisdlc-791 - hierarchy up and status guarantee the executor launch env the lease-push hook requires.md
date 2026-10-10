---
id: AISDLC-791
title: >-
  cli-hierarchy up guarantees, and status/doctor verify, the AI_SDLC_HIERARCHY_SESSION/ROLE launch env the lease-push hook binds executors by
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - hierarchy
  - governance
  - lease-push
dependencies: []
references:
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/status.ts
  - ai-sdlc-plugin/hooks/lib/trusted-policy.js
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-10-10 every hierarchy executor (`ai-sdlc-executor-{alpha..epsilon}`, started 08:14 PDT on plugin 0.26.0) had its lease push refused with `not-task-worktree` for AISDLC-669 (PR #1317) and AISDLC-674 (PR #1181), stalling the whole clear-pr-pressure drain. The hook (`trusted-policy.js` `holdsInflightClaim`) binds an executor by `AI_SDLC_HIERARCHY_SESSION` and `AI_SDLC_HIERARCHY_ROLE=executor` in its process env plus the `inflight/<task>.state.json` heartbeat; `cli-hierarchy up` (`buildClaudeCommand`, AISDLC-756) prefixes the launch command with those two assignments. tmux `#{pane_start_command}` and `ps -E` showed all five executors (and the dispatch session) were started as bare `claude --name ... /ai-sdlc executor`: the `up` that launched them ran from a pre-756 `pipeline-cli/dist`, which `resolve-pipeline-cli.sh` can pick from any worktree ("using this repo's own pipeline-cli build (worktree: ...)"). Nothing told the operator; the failure surfaced only as executor-raised decisions (DEC-0077, DEC-0079, DEC-0080) one task at a time. `cli-hierarchy clear` never relaunches a process, so it cannot repair it; only `down`/`up` from a current build does.

Make the launch contract observable and self-checking:
1. A unit test for `buildClaudeCommand` asserting that for every role the two env assignments precede the binary and name the roster entry (session name, role).
2. `cli-hierarchy status` (and `ai-sdlc doctor`, check name `hierarchy-launch-env`) reads each running roster entry's tmux `#{pane_start_command}` and flags an entry whose command lacks `AI_SDLC_HIERARCHY_SESSION=<its name>` and `AI_SDLC_HIERARCHY_ROLE=<its role>` as `env: missing` with the next step: "relaunch with `cli-hierarchy down --role <role>` then `up` from the main checkout's build". `up` refuses to start a session whose command would lack the prefix (impossible by construction after 1, but assert it).
3. `resolve-pipeline-cli.sh` never resolves to a worktree build older than the main checkout's: prefer `<main>/pipeline-cli/dist` when it exists; when it falls back to a worktree, print the dist mtime and the commit it was built from, and refuse (exit 1 with the build command) when `<main>/pipeline-cli/dist/hierarchy/up.js` is missing or older than `pipeline-cli/src/hierarchy/up.ts`.
4. The executor loop writes the `inflight/<task>.state.json` heartbeat immediately after the claim (before any model call), so the hook's second condition holds from the first push; `executor-start` fails loudly when the heartbeat cannot be written.
5. `docs/operations/cli-hierarchy.md` documents the launch-env contract, the `status` column, and the recovery.

Velocity impact: positive; the drain of 2026-10-10 lost ~1 hour and two executor contexts to this. No new gate; one new refusal only where the launch would already have failed at push time.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `buildClaudeCommand` test: for roles executor, operator-dispatch and planner, the command starts with `AI_SDLC_HIERARCHY_SESSION=<name> AI_SDLC_HIERARCHY_ROLE=<role>` before the `claude` binary.
- [ ] `cli-hierarchy status` shows an `ENV` column (`ok` / `missing`) per running entry derived from `#{pane_start_command}`; a bare launch shows `missing` and the JSON output carries `launchEnv: 'missing'` with a `nextStep` string (test with a fake tmux `run`).
- [ ] `ai-sdlc doctor` check `hierarchy-launch-env` reports the same and is listed in `docs/operations/cli-hierarchy.md`.
- [ ] `resolve-pipeline-cli.sh` prefers the main checkout's dist, prints the chosen dist's mtime, and exits 1 with the build command when the main dist is missing or older than `src/hierarchy/up.ts` (hermetic shell test).
- [ ] The executor loop writes `inflight/<task>.state.json` right after a successful claim; a test proves the file names the worker before the developer prompt is built.
- [ ] Docs updated; task cites DEC-0079 and DEC-0080.

## Notes

Incident thread: DEC-0077 (727), DEC-0079 (669, executor-beta), DEC-0080 (674, executor-alpha), planner diagnosis 2026-10-10 16:20Z. Related: AISDLC-756 (#1305) added the env binding; AISDLC-713 (roster identity).
