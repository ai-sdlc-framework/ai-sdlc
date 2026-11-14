---
id: AISDLC-1275
title: 'Untrusted run: the branch is checked for protected paths before push, and is never armed'
status: Done
assignee: []
created_date: '2026-11-13'
labels:
  - pipeline-cli
  - security
  - untrusted-run
dependencies: []
references:
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/runtime/untrusted-env.ts
  - pipeline-cli/src/governance/arm-via-gate.ts
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
priority: high
dispatchable: true
dispatchableReason: 'Audit finding F3 of 2026-11-13, verified by the planner at main 09915448. DEC-0403 (staged disclosure) authorizes filing once the F1 author gate (AISDLC-1269, #2655) has landed; it has. Tightens a control: class (a).'
---

## Description

**Gap.** An untrusted run is `/ai-sdlc execute` on a GitHub issue (source `gh-issue`, or an inline spec with no source kind). The only thing that keeps its developer agent away from governance files is the PreToolUse hook, which matches the text of each Bash command (`enforceUntrustedShellWrites`, `ai-sdlc-plugin/hooks/enforce-blocked-actions.js:412-475`). The hook says so itself at lines 447-448: "Glob, variable and eval forms of the protected names can still evade it." Confirmed shapes that pass:

- a variable: `d=.ai; echo x > "${d}-sdlc/agent-role.yaml"`;
- a glob: `cp evil.yml .ai-sd*/agent-role.yaml`;
- a script: write `x.sh` with the Write tool, then `bash x.sh`.

Nothing checks the result. `steps/10-finalize.ts` and `steps/11-push-and-pr.ts` contain no diff against protected paths, and the merge-time path review (`governanceSensitiveChanges`, `governance/merge-if-eligible.ts:1600`) is audit-only under DEC-0072. A second gap sits beside it: `execute-pipeline.ts:708` calls `armViaGate` with no `sourceKind`, so an issue-sourced PR is armed as `backlog`. Today only the task-id shape (`gh-issue-N` rejected by `deriveTaskId`) stops that merge, by accident and not by rule.

**Shape.** Command-text matching cannot be made complete, so the control moves to the one place the agent cannot talk its way past: the commits themselves. Before an untrusted run pushes, the pipeline lists every path changed between the base and the branch head and refuses the push when any of them is protected. An untrusted run is never armed.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the requirement is "an outsider's issue cannot change governance files through the maintainer's machine"; the hook only approximates it, a diff states it exactly. 2. Deleted: nothing in the hook (it still gives the agent an early, readable refusal); the implicit `backlog` default for issue-sourced arming goes. 3. Simplified or optimised: one `git diff --name-status -M` over the committed range, read by the pipeline process, not by the agent. 4. Accelerated: n/a. 5. Automated: unit tests per bypass shape, run against real temporary repositories.

- In `executePipeline`, when the run is untrusted, run the check after the last developer or fix round and before `pushAndPr`. Compare the manifest base with the branch head; include renames (both the old and the new name count), mode changes and deletions. Also refuse when the working tree or index still holds an uncommitted change to a protected path.
- The protected list is the hook's `UNTRUSTED_PROTECTED` list plus the marker and sentinel names. It lives once in `pipeline-cli/src/runtime/untrusted-env.ts`; a test fails when it and the hook's list differ.
- On a hit: no push, no PR, the verdict is `failed` with cause `untrusted-protected-path` and the offending paths in the notes; the worktree is kept for inspection.
- An untrusted run does not call `armViaGate`. The PR is opened and left for a maintainer.

## Acceptance Criteria

- [ ] #1 An untrusted run whose branch changes a file under `.ai-sdlc/`, `.github/workflows/`, `.claude/`, `.husky/` or `ai-sdlc-plugin/hooks/` is not pushed; the verdict is `failed`, cause `untrusted-protected-path`, and the notes list each path.
- [ ] #2 Tests reproduce the three bypass shapes above (variable, glob, script file) by committing the resulting change in a temporary repository; each is refused at the check.
- [ ] #3 A rename out of or into a protected directory, a mode change and a deletion of a protected file are each refused.
- [ ] #4 An uncommitted change to a protected path left in the worktree is refused.
- [ ] #5 A trusted run (backlog task) is unaffected: the check does not run and existing tests pass unchanged.
- [ ] #6 An untrusted run that passes the check opens its PR and does not arm it; a test asserts `armViaGate` is not called.
- [ ] #7 A test fails when the pipeline's protected list and the hook's `UNTRUSTED_PROTECTED` list differ.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
