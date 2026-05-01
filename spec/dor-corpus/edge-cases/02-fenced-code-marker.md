## Description
This issue is well-formed. Just make sure `pipeline-cli/src/dor/gates/gate-2-no-markers.ts` correctly ignores fenced markers like:

```
// TODO: ignored because fenced
```

## Acceptance Criteria
- [ ] #1 `pipeline-cli/src/dor/gates/gate-2-no-markers.ts` strips fenced code before scanning
