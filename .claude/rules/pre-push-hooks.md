---
paths:
  - ".husky/**"
  - "scripts/check-*.sh"
  - "scripts/pre-push-*.sh"
---

# Hooks (pre-push chain)

`.husky/pre-push` runs, in order: dark-code check (`AI_SDLC_SKIP_DARK_CODE_GATE=1`), then `pre-push-fixups.sh` once, which runs squash-attestation-chores, check-task-moved (task file to `backlog/completed/`, BEFORE sign) and check-attestation-sign (signs/verifies the DSSE envelope) in that order. Per-gate skips (`AI_SDLC_SKIP_*`) are never routine. Emergency only: `AI_SDLC_BYPASS_ALL_GATES=1` (document in the PR body; [`docs/operations/emergency-bypass.md`](docs/operations/emergency-bypass.md)).

- **Worktree hooks (AISDLC-693):** `core.hooksPath` is `.husky/_` (gitignored, made by `prepare`); a worktree without it runs NO gate. Never disable install scripts. `ai-sdlc doctor` check `worktree-hooks` lists affected worktrees.
- DoR and backlog-drift run in CI only; run by hand: `node pipeline-cli/bin/cli-dor-check.mjs --task <path>`, `npx backlog-drift check`.
- Per-hook behaviour and skips: [`docs/operations/pre-push-and-ci-reference.md`](docs/operations/pre-push-and-ci-reference.md).
