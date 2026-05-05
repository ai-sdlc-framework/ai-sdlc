---
id: AISDLC-195
title: Add unit test on ROLLBACK_OUTCOMES set in orchestrator/loop.test.ts
status: Done
assignee: []
created_date: '2026-05-05 00:20'
labels:
  - tests
  - pipeline-cli
  - reviewer-finding
dependencies:
  - AISDLC-191
references:
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/orchestrator/loop.test.ts
  - pipeline-cli/src/cli/execute.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Source

Test-reviewer follow-up from AISDLC-191. The `unknown-failure` lockstep test in `pipeline-cli/src/cli/execute.test.ts:605` asserts the consumer-side membership behavior. The constant itself lives in `pipeline-cli/src/orchestrator/loop.ts:125-130` and consumed by both `loop.ts` and `cli/execute.ts`.

Add a unit test directly on the constant in `loop.test.ts` so the lockstep contract is asserted at the source-of-truth, not only at the consumer. Catches a regression where someone changes the set in `loop.ts` without updating the consumer's expectations.

## Fix

```ts
import { ROLLBACK_OUTCOMES } from './loop.js';

describe('ROLLBACK_OUTCOMES contract', () => {
  it('contains exactly the 4 outcomes that trigger rollback', () => {
    expect(Array.from(ROLLBACK_OUTCOMES).sort()).toEqual([
      'aborted',
      'developer-failed',
      'developer-json-contract-violated',
      'unknown-failure',
    ]);
  });
});
```

Cheap regression guard.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipeline-cli/src/orchestrator/loop.test.ts gains a test asserting ROLLBACK_OUTCOMES contains exactly the 4 expected outcomes
- [ ] #2 Test fails in CI if any outcome is added or removed without updating the test
- [ ] #3 No production code changes
<!-- AC:END -->
