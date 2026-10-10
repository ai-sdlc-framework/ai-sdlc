---
id: AISDLC-719
title: >-
  Decision log append conflicts between concurrent pull requests
status: Done
assignee: []
created_date: '2026-10-04'
labels:
  - governance
  - tooling
dependencies: []
references:
  - .ai-sdlc/_decisions/events.jsonl
  - pipeline-cli/bin/cli-decisions.mjs
priority: medium
dispatchable: true
updated_date: '2026-10-07 01:42'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every pull request that records a decision appends to `.ai-sdlc/_decisions/events.jsonl`.
Two open pull requests that both append conflict as soon as one merges, and a filing branch
cannot be rebased under the lease-push guard, so on 2026-10-04 several filing pull requests
had to be consolidated by hand.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared
  `/tmp` path.

## Acceptance Criteria
- [x] Decisions recorded in concurrent pull requests merge without conflict (for example one event file per decision under `.ai-sdlc/_decisions/events/` with the existing log as a derived or legacy-read view, or another design with the same property).
- [x] `cli-decisions` reads both layouts and writes the new one.
- [x] Migration keeps existing ids and history.
- [x] Ids are allocated so two open pull requests cannot pick the same DEC id (for example a reserved-id check against open pull requests, or ids derived from the pull request).
- [x] Tests cover two branches each adding a decision merging cleanly in either order.
- [x] The pull request body carries a "Velocity impact" section.

## Out of scope
- Changing decision semantics.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
Decision events are now stored one file per event under `.ai-sdlc/_decisions/events/` (`<ts>__<DEC>__<type>__<hash12>.json`), so concurrent PRs that each record a decision add distinct paths and merge cleanly. The legacy `events.jsonl` is still read (deduped by content hash). `cli-decisions migrate` splits the legacy log, keeping ids, order and history. Open-PR DEC ids are reserved (same-repo PRs only, bounded ids, fail-open gh with timeout).

## Changes
- `pipeline-cli/src/decisions/event-log.ts` (modified): per-event writer, dual-layout reader, migration, safe file names.
- `pipeline-cli/src/decisions/remote-persist.ts` (modified): commits per-event files; open-PR id reservation hardened.
- `pipeline-cli/src/cli/decisions.ts` (modified): `migrate` subcommand, help text.
- `pipeline-cli/src/decisions/event-log-merge.test.ts` (new): two-branch merge in both orders, legacy conflict control, migration, id reservation, hardening.
- Other tests/comments updated for the new layout.

## Design decisions
- **Migrated files named `0-legacy-<seq>__...`**: sort before timestamped files and keep original append order (legacy log has non-monotonic timestamps).
- **Repo data not migrated in this PR**: reads support both layouts, so correctness does not depend on it; `node pipeline-cli/bin/cli-decisions.mjs migrate` is a one-time follow-up.
- **Id reservation is best-effort**: only sees pushed same-repo PRs (first 200).

## Verification
- `pnpm build` — clean
- `pnpm test` — decisions + cli + tui suites pass except 4 bin-invocation and some TUI timeouts that also fail on main
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 reviewers approved (code, test, security; Codex quota exhausted so Claude-native)

## Follow-up
- declined: running `cli-decisions migrate` on the repo's own events.jsonl is a separate operator/planner step (legacy log remains readable).
