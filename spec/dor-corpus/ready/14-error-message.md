## Description
`pipeline-cli/src/steps/01-validate.ts` returns a generic "validation failed" reason when the task file is missing — make it name the missing path.

## Acceptance Criteria
- [ ] #1 The reason string includes the absolute path that was searched
