## Description
Add the new `--dry-run` flag to `pipeline-cli/bin/ai-sdlc-pipeline.mjs` AND migrate all integration tests to use it AND remove the legacy mock-runner injection in `pipeline-cli/src/__test-helpers/fake-runner.ts` AND publish a 1.0 release of `@ai-sdlc/pipeline-cli`.

## Acceptance Criteria
- [ ] #1 `--dry-run` lands in `pipeline-cli/bin/ai-sdlc-pipeline.mjs`
- [ ] #2 All integration tests in `pipeline-cli/src/steps/` use the new flag
- [ ] #3 `FakeRunner` is removed from `pipeline-cli/src/__test-helpers/fake-runner.ts`
- [ ] #4 v1.0 of `@ai-sdlc/pipeline-cli` ships
