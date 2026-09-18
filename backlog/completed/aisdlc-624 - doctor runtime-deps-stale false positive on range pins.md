---
id: AISDLC-624
title: >-
  doctor runtime-deps-stale false positive on range pins (npm view --json)
status: Done
assignee: []
created_date: '2026-09-18'
labels:
  - plugin
  - doctor
  - bugfix
dependencies: []
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`ai-sdlc doctor` emits a permanent false-positive `runtime-deps-stale` warning even
when the installed runtime dep exactly matches what the pin resolves to. Live
example:

```
[WARN] runtime-deps-stale:@ai-sdlc/orchestrator: @ai-sdlc/orchestrator installed
v0.26.0, but pin >=0.25.0 <1.0.0 now resolves to v@ai-sdlc/orchestrator@0.26.0 '0.26.0'
```

Installed (`0.26.0`) equals the real resolved version (`0.26.0`), yet it reports
stale, and the resolved-version string is mangled — the package name and a quoted
version are embedded instead of a bare `0.26.0`.

### Root cause

`ai-sdlc-plugin/scripts/check-stale-runtime-deps.mjs`'s `resolveRegistryVersion`
ran `npm view <name>@<pin> version` (plain, not JSON). When the pin is a RANGE
(e.g. `>=0.25.0 <1.0.0`) that matches multiple published versions, `npm view ...
version` prints the DECORATED multi-line form, one line per match:

```
@ai-sdlc/orchestrator@0.25.0 '0.25.0'
@ai-sdlc/orchestrator@0.26.0 '0.26.0'
```

The script took `lines[lines.length - 1].trim()` as the target — the literal
decorated string, not a bare version — so `target !== installed` was always
true, producing a spurious stale line. Single-match pins were unaffected because
`npm view` prints just the bare version when there's exactly one match.

## Scope
- `resolveRegistryVersion` now calls `npm view <name>@<pin> version --json`.
  With `--json`, a single match returns a JSON string; a range with multiple
  matches returns a JSON array of bare version strings.
- Parses stdout as JSON. A string is the target directly. An array is reduced
  to its semver-MAX element via a small dependency-free numeric
  major.minor.patch comparator (a lexical sort would incorrectly rank `0.9.0`
  above `0.10.0`).
- All existing fail-open semantics are preserved unchanged: `ETIMEDOUT` still
  returns `{ target: '', timedOut: true }`; any other failure (non-zero exit,
  missing npm, empty/unparseable JSON) returns `{ target: '' }`. The function
  never throws.
- `orchestrator/src/cli/commands/doctor-checks.ts` needed no changes — it
  already splits the tab-delimited output into `[name, installed, target,
  pin]` and only needed `target` to be bare, which it now is.

## Acceptance Criteria
- [x] A range pin whose `npm view --json` output is a multi-element array
      resolves to the semver-MAX bare version as `target`.
- [x] When installed equals that semver-MAX, no stale line is emitted (the
      reported false positive from the bug is fixed).
- [x] A single-match pin (`npm view --json` returns a bare JSON string)
      resolves to that version unchanged (regression guard for the
      already-working case).
- [x] `installed < resolved` still emits a stale line with the correct bare
      target (regression guard for the real stale-detection path).
- [x] `ETIMEDOUT` behavior (empty stdout + `TIMEOUT\t...` on stderr) is
      unchanged.
- [x] Semver-max correctness: an array containing `0.9.0` and `0.10.0` picks
      `0.10.0` regardless of array order (not a lexical sort).
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
Only `ai-sdlc-plugin/scripts/check-stale-runtime-deps.mjs` and its test file
were touched. `doctor-checks.ts` and its consumer contract were verified
unchanged.
