## Description
Add an opt-in `AI_SDLC_DOR_DEBUG=1` env-var path in `pipeline-cli/src/dor/evaluate.ts` that prints per-gate verdicts to stderr.

## Acceptance Criteria
- [ ] #1 When the env var is set, each gate's verdict is logged to stderr
- [ ] #2 No output occurs when the env var is unset
