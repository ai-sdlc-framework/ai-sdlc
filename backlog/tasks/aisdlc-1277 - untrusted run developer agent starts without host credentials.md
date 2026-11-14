---
id: AISDLC-1277
title: 'Untrusted run: the developer agent starts without host credentials and not in bypass mode'
status: To Do
assignee: []
created_date: '2026-11-13'
labels:
  - pipeline-cli
  - security
  - untrusted-run
dependencies: []
references:
  - pipeline-cli/src/runtime/shell-claude-p-spawner.ts
  - pipeline-cli/src/runtime/shell-claude-p-spawner.test.ts
  - pipeline-cli/src/runtime/untrusted-env.ts
  - pipeline-cli/src/runtime/untrusted-env.test.ts
  - pipeline-cli/src/next-step/gh-issue.ts
  - ai-sdlc-plugin/commands/execute.md
priority: high
dispatchable: true
dispatchableReason: 'Audit finding F2 of 2026-11-13, verified by the planner at main 09915448. DEC-0403 (staged disclosure) authorizes filing once the F1 author gate (AISDLC-1269, #2655) has landed; it has. Tightens a control: class (a). This is the first of two layers; full isolation (container, no network) is a separate operator choice and is not in this task.'
---

## Description

**Gap.** When `/ai-sdlc execute` runs on a GitHub issue, the developer agent is started by `ShellClaudePSpawner` with:

- permission mode `bypassPermissions` by default (`pipeline-cli/src/runtime/shell-claude-p-spawner.ts:156`; the issue path in `next-step/gh-issue.ts` does not override it);
- the maintainer's whole environment: `env: { ...process.env, ...opts.env }` (lines 214-217), which carries `GH_TOKEN` or `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `NPM_TOKEN`, the SSH agent socket and the real `HOME` with its git and `gh` credentials.

The PreToolUse hook restricts only writes to protected paths. Nothing stops the agent from printing a token, calling `gh api` as the maintainer (adding a collaborator, for example), pushing a branch, or posting data out. The author gate from AISDLC-1269 decides whose issue may run; once a maintainer approves an outsider's issue with the `execute-approved` label, the text of that issue steers an agent holding the maintainer's credentials.

The agent needs none of them. The pipeline process, not the agent, pushes the branch and opens the PR (Step 11, `runtime/trusted-push.ts`).

**Shape.** An untrusted run starts its agent with an allowlisted environment, a throwaway `HOME`, no reachable git or GitHub credential and a non-bypass permission mode. The pipeline keeps its own credentials for the push.

**What this does not close.** The agent still runs as the maintainer's OS user, so it can read a file by absolute path (`/Users/<name>/.ssh/...`) and reach the network. Only OS-level isolation (a container with no host mounts and no network, as the reviewer sandbox already has) closes that. That layer is a separate decision; this task removes the credentials an agent gets for free.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does the agent need any host credential? No: it edits files and runs the project's build and tests; push and PR belong to the pipeline. 2. Deleted: environment inheritance and bypass mode for untrusted runs. 3. Simplified or optimised: an allowlist of variable names (short and reviewable) in place of a denylist that has to know every secret's name. 4. Accelerated: n/a. 5. Automated: spawner tests assert the exact environment handed to the child.

- `withUntrustedEnv` (`untrusted-env.ts`) marks the spawn as untrusted; for such a spawn `ShellClaudePSpawner` builds the child environment from an allowlist only: `PATH`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, `USER`, the Node and pnpm locations the build needs, the model-auth variables the `claude` binary itself requires, and the two `AI_SDLC_UNTRUSTED_*` keys. Everything else is dropped, `SSH_AUTH_SOCK` and every `*_TOKEN`, `*_KEY` and `*_SECRET` included.
- `HOME` and `XDG_CONFIG_HOME` point to an empty directory created for the run and removed after it; `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` point to `/dev/null`; `GIT_TERMINAL_PROMPT=0`. If `claude` cannot authenticate with a relocated `HOME`, pass its credential location explicitly by the documented variable and record which one in the PR body; do not fall back to the real `HOME`.
- The permission mode for an untrusted spawn is not `bypassPermissions`; the allowed tools are passed explicitly (Read, Grep, Glob, Edit, Write, Bash). MCP servers are not loaded.
- The in-session path: `ai-sdlc-plugin/commands/execute.md:30` only instructs the outer session to set the untrusted variable. `runGhIssue` refuses to hand an issue-sourced developer round to an in-session Agent; it always uses the shell spawner, so the scrubbed environment cannot be skipped.
- The pipeline's own steps (rebase, push, PR) keep the real environment.

## Acceptance Criteria

- [ ] #1 For an untrusted spawn, a test asserts the child's environment key set equals the allowlist; `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `NPM_TOKEN`, `SSH_AUTH_SOCK` and an arbitrary `FOO_SECRET` set in the parent are absent.
- [ ] #2 `HOME` in the child is a directory created for the run, empty at start and removed when the run ends, on success and on failure.
- [ ] #3 In a temporary repository with a credential helper configured in the real global git config, `git push` run with the child's environment fails for lack of credentials; `gh auth status` with that environment reports no login.
- [ ] #4 The argv of an untrusted spawn does not select `bypassPermissions`, and names the allowed tools; a test asserts both.
- [ ] #5 An issue-sourced run cannot use the in-session Agent path: a test shows `runGhIssue` selects the shell spawner or stops with a clear message when `claude` is not on PATH.
- [ ] #6 Step 11 of the same run still pushes and opens the PR with the pipeline's credentials (existing push tests pass).
- [ ] #7 A trusted run's spawn is unchanged; existing spawner tests pass unchanged.
- [ ] #8 `docs/operations/` gains a short section, "Untrusted run: what the agent can still reach", stating the two residual exposures (absolute-path reads, network).
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
