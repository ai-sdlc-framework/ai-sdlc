## Description
Add a `--dry-run` flag to `pipeline-cli/bin/ai-sdlc-pipeline.mjs` that prints
what would happen without touching git.

## Acceptance Criteria
- [ ] #1 `ai-sdlc-pipeline --dry-run sweep-worktrees` prints sweep candidates
- [ ] #2 No filesystem changes occur in dry-run mode
- [ ] #3 Help text in `pipeline-cli/src/cli/index.ts` documents the flag
