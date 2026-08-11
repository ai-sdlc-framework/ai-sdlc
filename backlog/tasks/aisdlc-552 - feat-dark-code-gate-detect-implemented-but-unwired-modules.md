---
id: AISDLC-552
title: >-
  feat(ci): dark-code gate — fail CI when a module ships with tests but is never
  exported or imported
status: To Do
assignee: []
labels:
  - ci
  - quality-gate
  - governance
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - scripts/check-rfc-docs.mjs
  - package.json
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Documenting RFC-0006 Addendum A surfaced a failure mode the pipeline cannot
currently see: a module can be written, unit tested, reviewed by three agents,
and merged **without ever being exported from a package barrel or imported by
any non-test file**. Its own tests pass, so every existing gate is green. The
code has zero runtime effect and adopters cannot reach it.

An ad-hoc scan on 2026-08-10 (no importer AND no barrel re-export; excluding
tests, `index.ts`, `cli/` entry modules and `bin/` shims; `.tsx` and `.mjs` bins
included in the corpus) found **26 dark modules across 567 candidates**,
attributed by the `RFC-NNNN` marker in each module's header docblock:

| RFC | Dark | Examples |
|---|---|---|
| RFC-0006 | 8 | `reference/src/policy/design-ci.ts`, `reference/src/policy/design-exemplar-bank.ts` |
| (no RFC marker) | 6 | `reference/src/core/validate-schemas.ts` |
| RFC-0008 | 3 | `orchestrator/src/design-quality-trend.ts` |
| RFC-0018 | 3 | `orchestrator/src/journey/metric-snapshot.ts` |
| RFC-0028 | 2 | `orchestrator/src/substrate/identity-class.ts` |
| RFC-0009 | 2 | `orchestrator/src/tessellation/cross-soul-provenance-rule.ts` |
| RFC-0043 / RFC-0023 | 1 each | |

This is **not** historical debt: `journey/metric-snapshot.ts` shipped the same
day as the scan (AISDLC-468, 42 unit tests, three reviewer approvals) and was
already dark on arrival. Without a gate the backlog of dark code grows with
every merge.

Note that `implementedBy:` frontmatter cannot serve as the index — only 2 of 39
RFCs declare source paths there. The per-module header docblock RFC marker is
the reliable join for attribution.

## Design

A standalone `scripts/check-dark-code.mjs`, following the shape of the existing
`scripts/check-rfc-docs.mjs` gate (pure exported functions + a thin CLI +
hermetic `node --test` coverage):

- **Reachability.** A candidate module is *reachable* when any other non-test
  source file, barrel, or `.mjs` bin references it via a static
  `from '…/<name>.js'` / `export … from '…/<name>.js'`, or a dynamic
  `import('…/<name>.js')`. Test files do not confer reachability — a module used
  only by its own test is exactly the failure mode being detected.
- **Candidates.** `.ts` / `.tsx` under the configured source roots, excluding
  `*.test.*`, `index.ts` barrels, and `cli/` + `bin/` entry modules (which are
  invoked by shims rather than imported).
- **Baseline, not big-bang.** The 26 existing dark modules are recorded in a
  committed baseline file. The gate fails only on modules that are **newly**
  dark, so it can land without a 26-module cleanup and still stop new ones. When
  a baselined module becomes reachable, the gate reports it so the baseline can
  shrink — the baseline is a ratchet, not a permanent exemption.
- **Allowlist.** Genuinely-unimported entry points (fixtures, demos, generators
  run by tooling) are declared explicitly with a required reason string, so an
  exemption is a reviewable decision rather than an invisible one.

## Scope discipline

Wiring any of the 26 existing dark modules is **out of scope** — that is
AISDLC-551 and its successors. This task only makes the condition visible and
stops it growing. Do not "fix" a dark module by adding a token import.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `scripts/check-dark-code.mjs` reports modules with no non-test importer and no barrel re-export, resolving static imports, `export … from`, and dynamic `import()` across `.ts`/`.tsx` sources and `.mjs` bins
- [ ] #2 Candidate selection excludes `*.test.*`, `index.ts`, and `cli/` + `bin/` entry modules; each exclusion is covered by a test
- [ ] #3 A committed baseline records the currently-dark modules; the gate exits non-zero ONLY for modules absent from the baseline, and reports (without failing) baselined modules that have since become reachable
- [ ] #4 `--update-baseline` regenerates the baseline file; an allowlist entry requires a reason string and is honoured
- [ ] #5 Each dark module is reported with its self-declared `RFC-NNNN` (or `—` when absent) so findings are attributable
- [ ] #6 Hermetic tests in `scripts/check-dark-code.test.mjs` cover: reachable-via-barrel, reachable-via-dynamic-import, reachable-via-mjs-bin, dark-because-only-test-imports-it, baseline suppression, and newly-dark failure
- [ ] #7 Wired into the repo test chain (`pnpm test:dark-code-gate`) and documented in CLAUDE.md's hooks/CI section
- [ ] #8 Running the gate on the current tree exits 0 (baseline covers the existing 26); artificially adding an unimported module makes it exit 1
- [ ] #9 Full verification passes: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check`
<!-- AC:END -->
