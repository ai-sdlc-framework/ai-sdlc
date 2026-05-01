## Description
The test `pipeline-cli/src/steps/03-setup-worktree.test.ts` is flaky on slow CI runners. Bump its per-call `timeoutMs` from 5s to 30s.

## Acceptance Criteria
- [ ] #1 The timeout option in `pipeline-cli/src/steps/03-setup-worktree.test.ts` is bumped to 30000
