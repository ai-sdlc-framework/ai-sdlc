---
id: AISDLC-613
title: Harden command-prefix bypass (sudo/env/nice) in stash + merge governance guards
status: To Do
priority: medium
labels:
  - security
  - hooks
created: 2026-09-14
---

## Context

Surfaced during the AISDLC-611 review rounds (code + security reviewers):
BOTH `enforceStashGovernance` and the pre-existing `enforceMergeGovernance` in
`ai-sdlc-plugin/hooks/enforce-blocked-actions.js` skip only a leading run of
`VAR=value` env assignments before matching the command token. A leading
**command prefix** — `sudo git stash pop`, `env git stash pop`,
`nice gh pr merge`, `xargs ... git stash pop` — is not skipped, so the first
token is `sudo`/`env`/`nice`/`xargs` (not `git`/`gh`) and detection returns "no
opinion" → the guarded op is ALLOWED.

This is a PRE-EXISTING gap shared by both guards (not introduced by AISDLC-611),
and unlike the truly-unmodelable shell-state class (inline `$X`, `eval`,
`base64|sh`), a static leading command-prefix IS skippable — the guards already
skip `VAR=value` prefixes the same way.

## Scope

- In the shared token-scan used by both `enforceStashGovernance` /
  `evaluateStashSegment` and `enforceMergeGovernance`, after skipping leading
  `VAR=value` assignments, ALSO skip a leading run of known command wrappers:
  `sudo` (+ its flags like `-u <user>`, `-E`), `env` (+ `VAR=val` and `-i`),
  `nice`/`ionice`, `time`, `command`, `builtin`, `xargs` (best-effort), so the
  real target token (`git`/`gh`) is reached.
- Keep fail-closed / basename-tolerant matching once the target is reached.
- Do NOT attempt to model inline shell-variable state / `eval` / pipe-to-sh —
  that is the documented out-of-scope hostile-agent class (belongs at the
  sandbox/permission layer), per the AISDLC-611 module-header scope note.

## Acceptance Criteria

- [ ] AC-1: `sudo git stash pop`, `env git stash pop`, `nice git stash pop`
      are BLOCKED (stash guard); `sudo gh pr merge <n>`, `env gh pr merge <n>`
      are BLOCKED (merge guard).
- [ ] AC-2: The prefix-skip does not over-block: `sudo make build`,
      `env FOO=bar git status`, an unrelated `time pnpm test` are NOT blocked.
- [ ] AC-3: Applied consistently to BOTH guards via the shared helper; hermetic
      `node --test` coverage for block + no-over-block + evasion (chained,
      flag-bearing sudo). `pnpm build && test && lint` clean.

## References

Surfaced by AISDLC-611 code + security reviewers as a shared pre-existing gap in
`ai-sdlc-plugin/hooks/enforce-blocked-actions.js` (stash + merge governance).
