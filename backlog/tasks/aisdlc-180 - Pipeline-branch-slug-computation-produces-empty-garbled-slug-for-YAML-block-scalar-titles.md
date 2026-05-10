---
id: AISDLC-180
title: >-
  Pipeline: branch slug computation produces empty/garbled slug for YAML
  block-scalar titles
status: To Do
assignee: []
created_date: '2026-05-04 02:49'
labels:
  - bug
  - pipeline-cli
  - framework-bug
dependencies: []
references:
  - pipeline-cli/src/steps/
  - .ai-sdlc/pipeline-backlog.yaml
  - >-
    backlog/tasks/aisdlc-178.1 -
    Phase-1-Skeleton-cli-tui-binary-Ink-scaffold-Overview-Mode-placeholder-panes.md
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Witness test of `cli-orchestrator start` on AISDLC-178.1 (2026-05-04) created a worktree on branch `ai-sdlc/aisdlc-178.1-` — note the **trailing dash with no slug**. The branch pattern is `ai-sdlc/{issueIdLower}-{slug}` from `.ai-sdlc/pipeline-backlog.yaml`. The slug came out empty.

## Root cause

The task file's title field uses YAML block-scalar literal:

```yaml
title: >-
  Phase 1: Skeleton — cli-tui binary, Ink scaffold, Overview Mode placeholder
  panes
```

The `>-` indicator means "folded scalar, strip trailing newlines." The actual title string is `"Phase 1: Skeleton — cli-tui binary, Ink scaffold, Overview Mode placeholder panes"`.

But the orchestrator's slug computation likely reads the raw frontmatter line `title: >-` and treats `>-` as the title (plus the next line as continuation). Then slug normalization (`tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'`) strips `>-` → empty string → trailing dash with no body.

Same root cause as a previously-noted cosmetic issue: `cli-deps frontier` displays such tasks with title `>-`. The cosmetic bug now has a critical real-world consequence — broken branch names break PR creation, attestation signing (which uses branch name as part of the contentHash context), and worktree-to-task mapping.

## Reproducer

Any task created via `mcp__backlog__task_create` with a long title gets the YAML block-scalar treatment by the backlog.md serializer. Several recently-created tasks have this shape: AISDLC-174, 175, 176, 177, 178.1, 178.2 (all decimal-suffix sub-tasks created in this session).

## Fix

The frontmatter parser used by the slug computer (and by `cli-deps` for display) MUST use a real YAML parser (`js-yaml` or equivalent) to handle block scalars correctly. The shell-pipeline approach in `.ai-sdlc/pipeline-backlog.yaml` for slug computation is the wrong tool — slug should be computed in TS code that already imports a YAML parser.

Suggested location: `pipeline-cli/src/steps/02-compute-branch.ts` (or wherever Step 2 lives) should parse the task file with `js-yaml.load()` and read `parsed.title` instead of any line-based regex.

## Severity

**High.** Every task with a long title (most operator-created tasks) currently produces a malformed branch. PRs would fail to open with the broken slug; even if they opened, the branch name is unhelpful for PR review (just `ai-sdlc/aisdlc-178.1-` tells the reviewer nothing).

Per RFC-0025 taxonomy: `framework-contract-violated` (branch pattern contract is `{slug}` non-empty) + `framework-determinism-violated` (same task title producing different branch results across runs depending on parser).

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 pipeline-cli/src/steps/ slug computation uses js-yaml (or equivalent real YAML parser) to read task title; never line-regex-based parsing of frontmatter
- [ ] #2 Slug normalization preserves at least 1 alphanumeric character; if input title produces empty slug, fail loud with clear error (don't silently emit empty)
- [ ] #3 cli-deps frontier displays unwrapped multi-line titles correctly (cosmetic fix that falls out of the same parser correction)
- [ ] #4 Unit tests cover: short title, long title with em-dashes (matches AISDLC-178.1 case), title with all special chars, title that would produce empty slug post-normalization (must fail loud)
- [ ] #5 Regression test: parse all existing backlog/tasks/aisdlc-* files; verify slug computation produces non-empty slugs for every one
<!-- AC:END -->
