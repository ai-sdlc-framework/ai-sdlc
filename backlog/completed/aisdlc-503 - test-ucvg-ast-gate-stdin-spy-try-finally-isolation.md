---
id: AISDLC-503
title: 'test: isolate ucvg ast-gate stdin spies in try/finally (AISDLC-501 reviewer minor)'
status: Done
assignee: []
created_date: '2026-06-03'
labels:
  - rfc-0043
  - untrusted-pr-verification
  - test-quality
  - follow-up
dependencies:
  - AISDLC-501
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Non-blocking minor raised by the code-reviewer during the AISDLC-501 (RFC-0043 Phase 5) reconcile review (PR #847). Filed for follow-up at operator request; it has no functional impact on the current passing suite.

In `pipeline-cli/src/cli/ucvg.test.ts`, three `ast-gate` tests create a `stdinOnSpy` (`vi.spyOn(process.stdin, 'on')`) and a paired `process.stdin.setEncoding` spy inside the test body, then call `stdinOnSpy.mockRestore()` / `vi.mocked(process.stdin.setEncoding).mockRestore?.()` AFTER the `await runUcvgCli(...)` but BEFORE the assertions, with no `try/finally`. If `runUcvgCli` ever rejects unexpectedly, the spies leak into subsequent tests in the same describe block (fragile cross-test isolation).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE_CRITERIA:BEGIN -->
- [ ] The three affected `ast-gate` tests in `pipeline-cli/src/cli/ucvg.test.ts` restore the `process.stdin.on` and `process.stdin.setEncoding` spies in a `finally` block (or the spies are hoisted into `beforeEach`/`afterEach`), so an unexpected rejection cannot leak them.
- [ ] `pnpm --filter @ai-sdlc/pipeline-cli exec vitest run src/cli/ucvg.test.ts` passes (all tests).
- [ ] No production code (`ucvg.ts`) change; test-only.
- [ ] No shared `/tmp/.ai-sdlc/` created by the suite (isolated mkdtemp invariant preserved).
<!-- SECTION:ACCEPTANCE_CRITERIA:END -->

## Notes

Source: code-reviewer finding on PR #847, `pipeline-cli/src/cli/ucvg.test.ts` ~line 425 (and the two sibling ast-gate tests). Mechanical fix; the behaviors are already correctly asserted — this only hardens isolation.
