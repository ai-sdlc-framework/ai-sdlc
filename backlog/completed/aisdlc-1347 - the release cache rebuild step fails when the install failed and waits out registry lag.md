---
id: AISDLC-1347
title: 'The release cache rebuild step fails when the install failed and waits out registry lag'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - release
  - ci
  - adopter
dependencies: []
references:
  - .github/workflows/release.yml
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
  - ai-sdlc-plugin/scripts/check-stale-runtime-deps.mjs
priority: low
dispatchable: true
dispatchableReason: 'Bounded to one workflow step and a test of its shell logic.'
---

## Description

**Gap.** After a release, one step rebuilds the plugin cache from the published packages and fails when a package is still older than the pin. When the install itself fails, that step reads the empty result of the stale check as "nothing is stale" and passes on the first attempt. A release can then be marked good with no runtime installed.

What was seen on the 0.43.0 release (run 44465874827, 2026-11-19 05:43Z, reported by an adopter project on plugin 0.43.0): `install-runtime-deps.sh --force` failed with ETARGET because orchestrator 0.43.0 was not on the registry yet. `check-stale-runtime-deps.mjs` printed nothing because nothing was installed, and the step printed "plugin cache rebuilt; no stale runtime dependency" on attempt 1 and exited 0. The packages appeared on the registry about six minutes later.

**Cause (read from the source).**

- The step "Rebuild plugin cache from the published runtime" is at `.github/workflows/release.yml:130-148`. Line 137 runs the install with `|| echo "... install failed (registry lag?)"`, so the failure is only printed and the loop goes on.
- Line 138 runs `check-stale-runtime-deps.mjs` and line 139 treats an empty result as success. That script always exits 0 and fails open: with no installed `package.json` it prints nothing (`ai-sdlc-plugin/scripts/check-stale-runtime-deps.mjs`, header notes on fail-open behaviour). An empty result therefore means "could not tell", not "converged".
- The retry loop is 5 tries of 30 seconds (`release.yml:134` and `:145`), about 2.5 minutes. The observed registry lag was about six minutes.

**Shape.** The step passes only when the install exited 0 and every pinned runtime dependency is present at the pinned version. A failed install is retried. The retry window covers normal registry lag, at least about 10 minutes in total.

**Control.** No control changes. The step already fails when a package is stale; it now also fails when the install failed. The change is in the workflow file `.github/workflows/release.yml`, in the step "Rebuild plugin cache from the published runtime" only.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should an unverified cache count as rebuilt? No. 2. Deleted: the reading of empty output as success. 3. Simplified or optimised: remember whether the install exited 0 in the loop and require it with the empty stale result; check that each pinned package has an installed version. 4. Accelerated: the step ends at the first good attempt, as now. 5. Automated: a test runs the step logic with a failing install and with a clean one.

- **Install result.** In `.github/workflows/release.yml`, record the exit code of `install-runtime-deps.sh`; an attempt succeeds only when it is 0 and the stale check prints nothing and every pinned package from the plugin manifest has an installed `package.json` at a version that satisfies the pin.
- **Retry window.** Raise the tries or the pause so the total wait is at least about 10 minutes; keep the final `::error::` and `exit 1`.
- **Test.** Add a workflow test next to the existing release workflow tests in `.github/workflows/__tests__/` that extracts the step script and runs it with a stub install that fails, and one that succeeds.

Out of scope: the publish step, the signing steps, the install script itself, and changing the stale check's fail-open design for its other callers.

## Acceptance Criteria

- [ ] #1 A test with an install that always fails ends the step with a non-zero exit and the existing `::error::` line, not with "plugin cache rebuilt".
- [ ] #2 A test with an install that fails once and then succeeds ends with exit 0.
- [ ] #3 A test with an install that exits 0 but leaves a pinned package missing ends non-zero.
- [ ] #4 The total retry wait in `release.yml` is at least about 10 minutes, and a test asserts the tries and the pause.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
