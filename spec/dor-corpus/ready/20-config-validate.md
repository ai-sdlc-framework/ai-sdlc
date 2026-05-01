## Description
Add JSON-schema validation to the `.ai-sdlc/dor-config.yaml` loader in `pipeline-cli/src/dor/types.ts` using `spec/schemas/dor-config.v1.schema.json`.

## Acceptance Criteria
- [ ] #1 Loader rejects an invalid config with a typed error
- [ ] #2 Loader returns a typed config on the happy path
