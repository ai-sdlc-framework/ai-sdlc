---
id: AISDLC-605
title: >-
  Governance enforcement follow-ups from RFC-0048 review (merge-matcher polish + permission-check.js parity)
status: In Progress
assignee: []
created_date: '2026-09-07'
labels:
  - plugin
  - governance
  - enforce-blocked-actions
  - rfc-0048
  - follow-up
dependencies: []
references:
  - spec/rfcs/RFC-0048-per-repo-configurable-governance.md
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/permission-check.js
priority: high
dispatchable: true
updated_date: '2026-10-07 16:25'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Surfaced by the AISDLC-602 code + security review (PR #1047, 2026-09-07).** RFC-0048
Phase 2 shipped the `enforce-blocked-actions.js` merge-governance check fail-closed
(raw `gh pr merge` blocked; only a recognized bare-`--auto` arm allowed; the
green+CLEAN gate lives in the AISDLC-603 `merge-if-eligible` helper). Review approved
it but flagged non-blocking follow-ups collected here. None is a security hole — the
two matcher items are safe-direction OVER-blocks, and `permission-check.js` is a
separate defense-in-depth layer.

## Scope
1. **Dropped by DEC-0066 (2026-10-07).** Raw `--auto` arming stays denied in both hooks; the sanctioned route is `cli-merge-if-eligible --arm` (AISDLC-753). Do not loosen the matcher or its tests.
2. **Only treat `#` as a shell comment at a word boundary** in `stripComment`.
   Today `stripComment` cuts at the FIRST `#`, so a legit arm using the
   `<repo>#N` positional form (`gh pr merge <repo>#42 --auto`) loses its
   `#42` and is over-blocked despite the positional regex explicitly allowing that
   form. Only strip `#…` when the `#` is preceded by whitespace or start-of-string.
3. **`permission-check.js` parity** (separate PermissionRequest hook, not touched by
   602): (a) it does its own generic `blockedActions` glob match; raw `--auto`
   arming stays denied there too (DEC-0066), so no carve-out is added; (b) it still reads `readFileSync('/dev/stdin')` — port it to the fd-0
   retry-loop read that `enforce-blocked-actions.js` / `subagent-start.js` already
   use (Linux `EAGAIN` on piped stdin, AISDLC-571 class bug).
4. **Optional:** extract the merge-matcher (`splitShellSegments` / `tokenizeShellish`
   / `isCleanAutoArmSegment`) into `ai-sdlc-plugin/hooks/lib/` so both hooks share one
   implementation and cannot drift.

## Notes for the operator (NOT code — cannot be done by a dev subagent)
- This repo's own `.ai-sdlc/agent-role.yaml` still carries a broad `gh pr merge*`
  entry under `blockedActions`. The generic loop runs AFTER the new merge-governance
  check, so that pattern independently RE-blocks `gh pr merge --auto` in THIS repo —
  neutralizing 602's `--auto` carve-out locally until the operator relaxes/removes
  that glob. Agents cannot edit `.ai-sdlc/**`; operator action required.

## Acceptance Criteria
- [ ] `permission-check.js` reads stdin from fd 0 (no `/dev/stdin`); raw `gh pr merge --auto` arming stays BLOCKED under the broad `gh pr merge*` policy (DEC-0066).
- [ ] Hermetic `node --test` coverage for each of the above, cross-platform-safe (no `/dev/stdin`, no >128KiB env values).
- [ ] The merge ban applies only when the merge command or merge API call is the command being run, not when the phrase appears in an argument, a heredoc, a grep pattern or an echo; wrappers such as `sh -c` fail closed.
- [ ] Write and Edit to the session scratch directory and OS temp directories are allowed by default by the worktree-confinement rule; confinement is unchanged for the main checkout, other worktrees and sibling repositories; tests cover both.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
Follow-up to RFC-0048 (Implemented 2026-09-07). Filed at operator instruction from
the PR #1047 review. The merge-governance matcher is best-effort defense-in-depth over
a raw command string — `$(...)`/eval obfuscation stays out of scope (branch protection
+ humans-merge is the real backstop); these items are usability/parity polish, not a
security gap.

2026-10-07 (planner): DEC-0066 answered opt-a, so AC1, AC2 and the arming half of AC3 were removed. Prior work exists: commit 25ddb76d on branch `ai-sdlc/aisdlc-605-governance-enforcement-follow-ups-from-rfc-0048-re` in `.worktrees/aisdlc-605` implements the remaining items (shared merge matcher, command-position merge ban, scratch-dir writes, fd-0 stdin). Rebase it onto main and continue; do not restart from scratch.
