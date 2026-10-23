---
id: AISDLC-1063
title: 'MCP tools check_issue and check_pr_status pass the repo argument to gh without a shell (command injection, GitHub issue 1970)'
status: In Progress
assignee: []
created_date: '2026-10-23'
labels:
  - security
  - mcp-server
  - external-report
priority: critical
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/mcp-server/src/tools/check-issue.ts
  - ai-sdlc-plugin/mcp-server/src/tools/check-pr-status.ts
  - ai-sdlc-plugin/mcp-server/src/tools/check-issue.test.ts
  - ai-sdlc-plugin/mcp-server/src/tools/check-pr-status.test.ts
---

## Description

External security report, GitHub issue 1970 (2026-10-23, CWE-78). The MCP tools `check_issue` and `check_pr_status` take an optional `repo` string and build the `gh` command as one shell string: `repoFlag = repo ? `--repo ${repo}` : ''` followed by `execSync(`gh issue view ${issueNumber} ${repoFlag} --json ...`)` (and the `gh pr view` twin). Shell metacharacters in `repo` (`;`, `$()`, `|`) run on the host with the operator's `gh` session. Verified against main: both files, lines 15 to 18, match the report. The exposure needs a caller that controls MCP tool arguments, in practice a prompt-injected model turn, so it is a real local code-execution path, not an unauthenticated network one; the reporter's CVSS 9.8 overstates it, the fix is still mandatory. The PR body says `Closes #1970`.

Fix: both tools call `execFileSync('gh', args, { encoding: 'utf-8', cwd: deps.projectDir, timeout: 15000 })` with an argument array (`['issue', 'view', String(issueNumber), ...(repo ? ['--repo', repo] : []), '--json', '<fields>']`), so no shell is involved. In addition the `repo` schema becomes `z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)` so a malformed value is refused with a readable error before any process runs. Keep the existing error shape and output format of both tools. Sweep `ai-sdlc-plugin/mcp-server/src` for any other `exec`/`execSync` call that interpolates a caller-supplied value into a shell string and convert it the same way in this PR; list the sweep result (files checked, hits converted) in the PR body. Do not post on the issue from the executor; the planner handles the reporter reply.

**Five-step review (requirements first).** Requirement questioned: does `repo` need to be a free string at all? No: the only valid form is `owner/name`, so the schema narrows to that. Deletion: the `repoFlag` string concatenation and the shell invocation are deleted. Simplified: one argument array per tool, no escaping logic. Accelerated: the schema refuses bad input before a process spawns. Automated last: tests pin both the no-shell call shape and the schema refusal so a regression fails in CI.

## Acceptance Criteria

- [ ] Both tools spawn `gh` through `execFileSync` (or `spawnSync` with an args array) and the `child_process` test doubles in `check-issue.test.ts` and `check-pr-status.test.ts` assert the exact argument array, including `['--repo', '<value>']` when `repo` is given and no `--repo` pair when it is omitted; no production code in `ai-sdlc-plugin/mcp-server/src` builds a shell string from a caller-supplied value.
- [ ] A test per tool passes `repo: 'foo/bar; echo pwned'` and `repo: '$(id)'` and asserts the tool returns a validation error and that the `child_process` double was never called.
- [ ] A test per tool passes `repo: 'owner/name'` and asserts the existing success output is unchanged; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; the PR body carries `Closes #1970` and the sweep result; `ai-sdlc/pr-ready` green.
