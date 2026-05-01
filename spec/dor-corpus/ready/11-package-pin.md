## Description
Pin `vitest` to the same minor version across all workspace packages — currently `pipeline-cli/package.json` and `orchestrator/package.json` differ.

## Acceptance Criteria
- [ ] #1 Both `pipeline-cli/package.json` and `orchestrator/package.json` declare `vitest: ^3.2.4`
- [ ] #2 `pnpm install` regenerates `pnpm-lock.yaml` cleanly
