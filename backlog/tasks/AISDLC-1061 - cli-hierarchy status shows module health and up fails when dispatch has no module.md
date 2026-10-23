---
id: AISDLC-1061
title: 'cli-hierarchy status shows each session hooks-module state and up fails loudly when the dispatch host has no module, so an inert hierarchy is visible in one line'
status: In Progress
assignee: []
created_date: '2026-10-23'
labels:
  - pipeline-cli
  - hierarchy
  - rca-2026-10-23
priority: high
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/cli-hierarchy.md
---

## Description

RCA 2026-10-23, cause 3. For about ten hours no roster session had the hierarchy hooks module loaded (validator refusal), so there were no ticks, no executor wakes and no rotations, and nothing said so. `cli-hierarchy status` reported every session `busy`/`idle` with `ENV ok`; the module's one-line refusal went to a pane and the `$.store` log that nobody reads; the dispatch model answered a probe with "this prompt reached me outside the model-less host" and stopped.

Make module health a first-class status. The module's `session.start` gate writes a small heartbeat file under `<board-dir>/handoff/module-<roster-name>.json` (`{state: loaded|refused|absent, reason, version, at}`) through the process primitive it already has, refreshed on every tick for the dispatch role. `status` adds a `MODULE` column read from those files (absent file = `absent`), and `up` ends with a check that the dispatch host reports `loaded` within two tick intervals, else exits 1 with the reason and the fix line from the runbook. `doctor` gains the same check. Update `docs/operations/cli-hierarchy.md` (status table, troubleshooting entry "module absent").

**Five-step review (requirements first).** Requirement questioned: should the CLI read `$.store` instead? A module has no file API for the CLI to read, and the store is per session; a file under the board is what the CLI already reads. Deletion: nothing. Simplified: one JSON file per session, one column. Accelerated: `up` fails in under a minute instead of a silent day. Automated last: `doctor` and `up` checks.

## Acceptance Criteria

- [ ] With the module refused (simulate by pointing `hooks.json` at a module that throws), `cli-hierarchy status` shows `MODULE refused: <reason>` for every session and `up` exits 1 naming it; with the fixed module every session shows `loaded`.
- [ ] A session launched without a hierarchy role shows `absent`, not an error.
- [ ] Runbook updated; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
