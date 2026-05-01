## Description
Short-circuit `evaluateIssue()` in `pipeline-cli/src/dor/evaluate.ts` for issues whose body is under 10 characters — never going to be DoR-ready, no point burning the gate stack.

## Acceptance Criteria
- [ ] #1 `evaluateIssue()` returns a structured short-circuit verdict for sub-10-char bodies
- [ ] #2 The verdict's gates array marks all gates as 'skip' with finding "body too short"
