## Description
Emit a `[ai-sdlc-progress] dor-evaluate: ...` line from `evaluateIssue()` in `pipeline-cli/src/dor/evaluate.ts` when the orchestrator calls it.

## Acceptance Criteria
- [ ] #1 `evaluateIssue()` emits one progress line per call
- [ ] #2 The line is suppressed when the optional `silent` evaluator opt is true
