---
id: AISDLC-1278
title: 'Untrusted run: the developer agent runs in a container without host files or open network'
status: In Progress
assignee: []
created_date: '2026-11-13'
labels:
  - pipeline-cli
  - security
  - untrusted-run
dependencies:
  - AISDLC-1277
references:
  - pipeline-cli/src/runtime/shell-claude-p-spawner.ts
  - pipeline-cli/src/runtime/untrusted-env.ts
  - pipeline-cli/src/pipeline/reviewer-container.ts
  - pipeline-cli/src/pipeline/sandbox-runner.ts
  - pipeline-cli/src/next-step/gh-issue.ts
  - pipeline-cli/src/runtime/trusted-push.ts
priority: high
dispatchable: true
dispatchableReason: 'Audit finding F2 of 2026-11-13, second layer; verified by the planner at main 09915448. DEC-0403 (staged disclosure) authorizes filing once the F1 author gate (AISDLC-1269, #2655) has landed; it has. The operator ordered this filing on 2026-11-13. Tightens a control: class (a). Depends on AISDLC-1277 (first layer).'
---

## Description

**Gap.** AISDLC-1277 removes the credentials an issue-sourced developer agent gets for free (inherited environment, real `HOME`, bypass mode). Two exposures remain after it, because the agent still runs as the maintainer's OS user on the maintainer's machine:

- it can read any file that user can read by absolute path (SSH keys, `~/.config/gh/hosts.yml`, other repositories, browser profiles);
- it can open any network connection, so whatever it reads it can send out, and it can fetch and run anything.

An outsider's issue text steers this agent once a maintainer has applied the `execute-approved` label (AISDLC-1269). Only OS-level isolation closes the two exposures. The reviewer path already has it (`pipeline/reviewer-container.ts`, `pipeline/sandbox-runner.ts`); the developer path does not.

**Shape.** For an untrusted run the developer agent runs inside a container that sees one thing from the host, the task worktree, and reaches one thing on the network, the model API through the pipeline's proxy. The pipeline process stays on the host and keeps doing the rebase, push and PR (Step 11, `runtime/trusted-push.ts`). A trusted run is unchanged.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does the agent need the host file system or the open network? No: it needs the worktree, a toolchain and the model API. 2. Deleted: host file system and network reach for untrusted developer runs; the "what the agent can still reach" residual list from AISDLC-1277 shrinks to nothing or to what this task documents. 3. Simplified or optimised: reuse the reviewer container driver and proxy; no second container stack. 4. Accelerated: dependencies are installed once, before the agent starts, not inside its session. 5. Automated: tests assert the container arguments; one integration test runs when a container runtime is present.

- For a spawn marked by `withUntrustedEnv`, `ShellClaudePSpawner` (or a sibling spawner chosen by `runGhIssue`) starts the agent through the container driver the reviewer path uses. Mounts: the task worktree read-write, nothing else from the host. No home directory, no SSH agent socket, no Docker socket, no git credential. The environment is the allowlist from AISDLC-1277.
- Image: pinned by digest, with git, Node and pnpm at the versions the repository pins. No image by tag.
- Network: no default route. The only egress is the model API host through the pipeline's existing proxy, which binds to a loopback or container-only address, not all interfaces. Model credentials stay with the host-side proxy; the container never receives them (the invariant the reviewer sandbox already keeps).
- Dependencies: the pipeline installs them from the lockfile on `main` before the agent starts, with lifecycle scripts off, into the worktree or a read-only volume. The agent cannot reach a package registry. A run whose change needs a new or changed dependency stops with a clear message naming the package; a maintainer takes it over as a trusted run. State this limit in the docs.
- The worktree's `.git` metadata: the agent may commit, but hooks do not run inside the container from host paths and `core.hooksPath`, `core.fsmonitor` and `core.sshCommand` set by the agent are ignored by the host: the pipeline runs every later git command with those keys overridden. The post-run protected-path check of AISDLC-1275 runs on the host after the container exits.
- No container runtime on the machine: an untrusted run stops before the agent starts with a message naming the missing runtime. It never falls back to the host spawn.
- Container limits: CPU, memory, process count and wall-clock limits as the reviewer sandbox sets them; the container is removed after the run, on success and on failure.

Out of scope: the seccomp profile and environment denylist of the reviewer sandbox (audit items G1, G3), and trusted runs.

## Acceptance Criteria

- [ ] #1 For an untrusted spawn, a test asserts the container arguments: exactly one host mount (the task worktree), no home, SSH socket or Docker socket mount, an image reference by digest, and the network setting that leaves only the proxy reachable.
- [ ] #2 Integration test (skipped with a stated reason when no container runtime is present): inside the container, reading a file outside the worktree that exists on the host fails; a request to a host other than the model API fails; a request to the model API through the proxy succeeds.
- [ ] #3 The container's environment holds no model credential, no `*_TOKEN`, `*_KEY` or `*_SECRET`; a test asserts it.
- [ ] #4 The proxy listens only on a loopback or container-only address; a test asserts the bind address.
- [ ] #5 With no container runtime available, an untrusted run stops before any agent starts and the message names the runtime; a test asserts there is no host spawn.
- [ ] #6 A worktree in which the agent set `core.hooksPath`, `core.fsmonitor` or `core.sshCommand` does not make the host run agent-chosen code in Step 10 or Step 11; a test asserts the overrides on the host git calls.
- [ ] #7 A run whose diff changes a dependency manifest or lockfile stops with a message naming the file; a test asserts it.
- [ ] #8 The container is removed after the run on success and on failure.
- [ ] #9 A trusted run's spawn is unchanged; existing spawner tests pass unchanged. Step 11 still pushes and opens the PR with the pipeline's credentials.
- [ ] #10 The docs section "Untrusted run: what the agent can still reach" (added by AISDLC-1277) is updated to the state after this task, including the dependency limit.
- [ ] #11 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
