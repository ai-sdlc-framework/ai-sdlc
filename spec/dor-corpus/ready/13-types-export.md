## Description
The `StageAVerdict` type lives in `pipeline-cli/src/dor/types.ts` but isn't exported from the package's public entry point. Re-export it from `pipeline-cli/src/index.ts`.

## Acceptance Criteria
- [ ] #1 Consumers can `import { type StageAVerdict } from '@ai-sdlc/pipeline-cli'`
