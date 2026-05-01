## Description
While we're in `pipeline-cli/src/dor/evaluate.ts` for the bug fix, also add Stage B prompt rendering, refactor the resolver registry in `pipeline-cli/src/dor/resolvers/index.ts` to be plugin-based, port the corpus runner in `pipeline-cli/src/dor/corpus.ts` to a separate package, and update `spec/rfcs/RFC-0011-definition-of-ready-gate.md` Section 5.6.

## Acceptance Criteria
- [ ] #1 Bug fix in `pipeline-cli/src/dor/evaluate.ts` is in
- [ ] #2 Stage B prompts render
- [ ] #3 Resolver registry is plugin-based
- [ ] #4 Corpus runner ships as separate package
- [ ] #5 `spec/rfcs/RFC-0011-definition-of-ready-gate.md` Section 5.6 updated
