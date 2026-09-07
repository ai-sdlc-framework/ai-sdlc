---
id: AISDLC-605
title: >-
  Governance enforcement follow-ups from RFC-0048 review (merge-matcher polish + permission-check.js parity)
status: To Do
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
priority: medium
dispatchable: true
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
1. **Accept `--auto=<truthy>` as arming** in `enforceMergeGovernance` /
   `isCleanAutoArmSegment`. Today only a BARE `--auto` token counts, so a legitimate
   `gh pr merge --auto=true` (and `--auto=1`/`--auto=yes`) is over-blocked. Treat
   `--auto` / `--auto=true` / `--auto=1` / `--auto=yes` as arming; keep
   `--auto=false` / `--auto=0` / `--auto=no` as NOT arming (immediate merge → block).
2. **Only treat `#` as a shell comment at a word boundary** in `stripComment`.
   Today `stripComment` cuts at the FIRST `#`, so a legit arm using the
   `owner/repo#N` positional form (`gh pr merge owner/repo#42 --auto`) loses its
   `#42` and is over-blocked despite the positional regex explicitly allowing that
   form. Only strip `#…` when the `#` is preceded by whitespace or start-of-string.
3. **`permission-check.js` parity** (separate PermissionRequest hook, not touched by
   602): (a) it does its own generic `blockedActions` glob match with no `--auto`
   carve-out, so in repos with a broad `gh pr merge*` pattern it also over-blocks
   arming — fold in the same carve-out (or delegate to the shared merge-governance
   logic); (b) it still reads `readFileSync('/dev/stdin')` — port it to the fd-0
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
- [ ] `gh pr merge --auto=true` (and `--auto=1`/`--auto=yes`) is ALLOWED; `--auto=false`/`--auto=0` stays BLOCKED.
- [ ] `gh pr merge owner/repo#42 --auto` is ALLOWED (the `#42` positional is preserved).
- [ ] `permission-check.js` allows `gh pr merge --auto` arming under a broad `gh pr merge*` policy, and reads stdin from fd 0 (no `/dev/stdin`).
- [ ] Hermetic `node --test` coverage for each of the above, cross-platform-safe (no `/dev/stdin`, no >128KiB env values).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
Follow-up to RFC-0048 (Implemented 2026-09-07). Filed at operator instruction from
the PR #1047 review. The merge-governance matcher is best-effort defense-in-depth over
a raw command string — `$(...)`/eval obfuscation stays out of scope (branch protection
+ humans-merge is the real backstop); these items are usability/parity polish, not a
security gap.
