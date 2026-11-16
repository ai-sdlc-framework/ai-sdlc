---
id: AISDLC-1286
title: 'Dev dependency group moves to prettier 3.10.1 with the one affected file reformatted (replaces dependabot #2684)'
status: To Do
assignee: []
created_date: '2026-11-16'
labels:
  - dependencies
  - chore
dependencies: []
references:
  - package.json
  - pnpm-lock.yaml
  - .ai-sdlc/templates/decisions-config.yaml
priority: medium
dispatchable: true
dispatchableReason: 'Dependabot PR #2684 has failed `Lint & Format` since 2026-11-16 07:55Z (run 43827061083) and was routed to the planner as a real failure. The planner decided on 2026-11-16, with the operator present and delegating, to land the bumps through a task, as AISDLC-1274 did for #2653.'
---

## Description

**Gap.** Dependabot PR #2684 bumps four development dependencies across the workspace:

| Package | From | To |
| --- | --- | --- |
| `prettier` | 3.9.10 | 3.10.1 |
| `typescript-eslint` | 8.72.1 | 8.72.2 |
| `vite` | 8.3.6 | 8.3.8 |
| `@types/vscode` | 1.145.0 | 1.146.0 |

`prettier` 3.10.1 formats `.ai-sdlc/templates/decisions-config.yaml` differently, so `pnpm format:check` fails on the PR:

```
[warn] .ai-sdlc/templates/decisions-config.yaml
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
```

Dependabot cannot run the formatter, so the PR cannot go green by itself.

**Decision (planner, 2026-11-16).** Options weighed: a replacement task; a formatting commit pushed onto the dependabot branch; a dependabot ignore for `prettier` 3.10; leaving the PR open. The replacement task was chosen. The strongest case against it is that one commit on the dependabot branch is faster. It was rejected because a second author on that branch ends Dependabot's own rebases and puts the bot exemptions of the gate in doubt, and the planner does not write code from the parent checkout. An ignore only moves the same failure to the next `prettier` release.

**Shape.** One PR from a task branch carries the four bumps and the reformatted file. Dependabot closes #2684 itself once `main` has the versions.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must all four bumps land together? Yes: they are one dependabot group and three of them are patch releases with no reported failure; splitting them makes two PRs for no gain. 2. Deleted: nothing. 3. Simplified or optimised: the formatter is run once over the repository instead of editing the file by hand. 4. Accelerated: not applicable. 5. Automated: the existing `format:check` step is the check.

- Apply the four version changes of #2684 to every `package.json` that PR touches and regenerate `pnpm-lock.yaml` with `pnpm install`. Take the list of files from the PR diff (`gh pr diff 2684 --name-only`).
- Run `pnpm format`. The only expected change is whitespace or quoting in `.ai-sdlc/templates/decisions-config.yaml`. This task names that file: the change is formatting only, and no key or value in it changes.
- When the formatter changes any other file, include it and list it in the PR body.
- Do not close #2684 and do not push to its branch. Name #2684 in the PR body.

Out of scope: any major version bump; the dependabot configuration.

## Acceptance Criteria

- [ ] #1 The four packages are at the versions in the table in every workspace `package.json` that #2684 changes, and `pnpm-lock.yaml` matches (`pnpm install --frozen-lockfile` passes).
- [ ] #2 `pnpm format:check` passes.
- [ ] #3 The diff of `.ai-sdlc/templates/decisions-config.yaml` changes formatting only: the parsed YAML is equal before and after (state the check used in the PR body).
- [ ] #4 The PR body names #2684 and lists every file the formatter changed.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
