---
name: feedback_overbuild_patch_coverage_locally
description: operator 2026-10-22: overbuild patch coverage and verify it locally before pushing; a CI coverage red forces a full re-run of every gate
metadata:
  type: feedback
---

Overbuild patch coverage on every code PR and prove it locally before the push: new source files must appear in the coverage table of the package's test run, and `node scripts/check-pr-patch-coverage.mjs` must pass against origin/main. Aim well above the 89-90% patch threshold (95%+ on new files), not at it.

**Why:** PR #1913 (AISDLC-1033) went red on `[patch-coverage] MISSING: register.ts 0/146` because the mods Vitest `coverage.include` did not list the new folder; the tests existed but the file was never instrumented. Operator: "this is why I requested that we over build out the coverage so we don't hit coverage on CI/CD which requires a full re-run and re-test for CI/CD gates; by over compensating it reduces the chance of this re-work". A coverage red costs a reviewer round plus a complete CI rerun.

**How to apply:** in dev prompts and reenter notes, name the coverage include that must list the new path, and require the local coverage table plus the patch-gate script before push. Put a new file under an instrumented include before writing its tests. Related: [[feedback_coverage_gate_authority]], [[feedback_diagnose_ci_from_real_fail_line]].
