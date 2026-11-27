---
id: AISDLC-1395
title: 'Doctor warns when autoMemoryDirectory is not set'
status: In Progress
assignee: []
created_date: '2026-11-23'
labels:
  - enhancement
  - orchestrator
  - doctor
dependencies: []
references:
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor.ts
  - pipeline-cli/src/memory-dream/resolve-dir.ts
priority: medium
---

## Description

**Gap.** This repository keeps agent memory in `.claude/memory` through the Claude Code setting `autoMemoryDirectory`, which lives in the untracked `.claude/settings.local.json`. When the repository was deleted and re-cloned on 2026-10-30, that file was lost; the rebuilt copy (2026-11-01) lacked the setting, so from 2026-10-30 every new session silently wrote memory to `~/.claude/projects/<slug>/memory`. The governance hook then refused writes there as outside the project, so memory saves failed for three weeks before anyone noticed (operator, 2026-11-22). Nothing reports which memory folder sessions resolve to.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the operator needs to know when sessions will write memory somewhere other than the project's memory folder; whether to set the key is the adopter's choice. 2. Deleted: nothing. 3. Simplified: reuse `resolveMemoryDir` (`pipeline-cli/src/memory-dream/resolve-dir.ts`), which already resolves the folder the way sessions do. 4. Accelerated: none. 5. Automated: the doctor check itself.

- Add a doctor check that resolves the memory folder with the same precedence (project local, project, user settings). When `.claude/memory` exists in the project but the resolved folder is elsewhere, warn with the resolved path and the one-line fix (`"autoMemoryDirectory": ".claude/memory"` in `.claude/settings.local.json`).
- When no project memory folder exists, the check passes quietly (adopters that never chose a project folder are fine).
- `--fix` does not write the setting (settings files are the operator's), it prints the line to add.

## Acceptance Criteria

- [ ] #1 A test: project has `.claude/memory`, no settings key -> doctor warns and names the resolved default folder and the fix line.
- [ ] #2 A test: key set in `.claude/settings.local.json` to `.claude/memory` -> the check passes.
- [ ] #3 A test: no `.claude/memory` folder and no key -> the check passes.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
