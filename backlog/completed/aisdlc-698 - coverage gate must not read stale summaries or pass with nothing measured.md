---
id: AISDLC-698
title: >-
  Pre-push coverage gate: ignore coverage summaries it did not just produce, and do not pass when it measured nothing for a changed package
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - hooks
  - coverage
  - dx
dependencies: []
references:
  - scripts/check-coverage.sh
  - CLAUDE.md
priority: high
dispatchable: true
---

## Resolution

Superseded by AISDLC-726 per DEC-0056 (planner, 2026-10-06).

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two observations on 2026-10-03, on two different branches, both in worktrees:

1. A push was blocked with `reference lines coverage 60.25% < 80%` (and, on another
   branch, `5.55%`). The number came from `reference/coverage/coverage-summary.json`
   left behind by an earlier single-file `vitest run --coverage` (a reviewer agent and a
   developer each ran one). The summary listed one source file. The gate's own
   `pnpm --filter "...[origin/main]" test:coverage` run had not rewritten it.
2. After the stale file was removed, the same push passed with
   `all checked packages above 80% lines coverage (0 walked)`, although the push changed
   source in `reference/`. Nothing was measured.

Both follow from the same path in `scripts/check-coverage.sh`: when the affected-package
list comes back empty (the script already notes that pnpm's git-ref filter can return
nothing in a worktree), no coverage run happens for the changed package, and the walk
then accepts every `coverage-summary.json` it finds, whatever produced it. The script's
comment says stale summaries from prior runs are avoided; with an empty affected set
they are not.

The operator asked for this to be filed (2026-10-03).

## Conventions
- Bash for the gate; hermetic `node --test` tests in temporary repositories, as the other
  gate tests do. No real coverage run in tests: the test command is injectable.
- No new skip variable. `AI_SDLC_SKIP_COVERAGE_GATE` keeps its meaning. The 80% bar does
  not move.

## Scope
1. A summary is only read when this gate run produced it: record a start marker before
   the coverage run and ignore, with a one-line notice naming the file, any summary whose
   modification time is older.
2. The set of packages to check is derived from the files changed against the merge
   base, not only from pnpm's filter. When the two disagree (a package has changed source
   files but pnpm's filter did not select it), the gate runs coverage for that package
   explicitly.
3. A changed package with a `test:coverage` script and no fresh summary after the run is
   a failure with a message naming the package, never a silent pass. A push that changes
   no package source keeps passing with nothing walked.
4. The final line reports how many packages were measured and names them.
5. Update the gate description in `CLAUDE.md` (Hooks, item 2).

## Acceptance Criteria
- [ ] Fixture: a stale `coverage-summary.json` below the threshold in a package the push does not change is ignored and the push passes, with a notice naming the file.
- [ ] Fixture: the push changes source in a package, the injected coverage run writes no summary, and the gate fails naming the package.
- [ ] Fixture: the push changes source in a package and pnpm's filter returns an empty list; the gate still runs coverage for that package and checks the fresh summary.
- [ ] Fixture: a fresh summary below the threshold fails; at or above passes.
- [ ] A docs-only push passes with zero packages measured and says so.
- [ ] The gate's hermetic tests run under `pnpm test` and pass.
<!-- SECTION:DESCRIPTION:END -->
