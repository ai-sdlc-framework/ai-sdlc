---
id: aisdlc-569
title: Retire the stale .claude/hooks enforce-blocked-actions copy + symlink/stale-base hardening
status: Done
priority: high
labels:
  - security
  - worktree-isolation
  - aisdlc-567-followup
---

## Description

Follow-ups surfaced by the AISDLC-567 review (PR #982). AISDLC-567 shipped the
configurable-`blockedPaths` + active-worktree isolation logic in the plugin hook
`ai-sdlc-plugin/hooks/enforce-blocked-actions.js`, but three items were flagged
out-of-scope for that PR and deferred here.

### Part A — retire/repoint the stale `.claude/hooks/enforce-blocked-actions.js` (security-relevant, MAJOR from 567 code review)

This repo's OWN dogfooded Claude Code sessions are wired via `.claude/settings.json`
to `.claude/hooks/enforce-blocked-actions.js`, NOT the `ai-sdlc-plugin/hooks/` copy
that AISDLC-567 fixed. That `.claude/hooks/` copy is a pre-existing, older
implementation that only checks Bash commands against `blockedActions` — **zero
Write/Edit enforcement** (no `blockedPaths`, no `.ai-sdlc/**` floor, no
worktree-scoped isolation, no case-insensitive matching). Net effect: the isolation
gap AISDLC-567 set out to close is NOT actually closed for agents running inside
this repository's own sessions — which is the exact class of failure behind the
original incident (a downstream agent writing directly into the framework parent
tree). Retire the stale copy: either delete it and point `.claude/settings.json` at
the `ai-sdlc-plugin/hooks/` version, or make `.claude/hooks/enforce-blocked-actions.js`
a thin shim that delegates to the plugin implementation. Verify this repo's live
sessions then get the full Write/Edit floor + worktree isolation.

### Part B — symlink/realpath hardening (MINOR from 567 security review)

`enforce-blocked-actions.js` uses `resolve()` (lexical) for its worktree-containment
and floor checks, which does NOT follow symlinks. A symlink inside the worktree
pointing outside it (or vice versa) can evade the boundary. Harden the containment
and floor checks to `realpath`-resolve both the candidate path and the boundary
before comparing (mirror the `isInsideRepoRoot()` realpath approach shipped in the
AISDLC-566 verifier). Note the reviewer's caveat: because Bash shell-redirection
(`echo`/`cp`/`tee`/`ln`) is already an unguarded parallel write channel, this floor
is a partial boundary regardless — but a security-boundary file should not carry a
known lexical-vs-real path gap.

### Part C — `warnIfStaleBase()` latency (MINOR from 567 code review)

`warnIfStaleBase()` spawns a synchronous `git` subprocess on every single Write/Edit
call. Best-effort/fail-silent so not a correctness issue, but on edit-heavy sessions
this adds latency. Cache the result per-process (or check at most once per N seconds)
so it doesn't shell out on every hook invocation.

## Acceptance Criteria

- [x] This repo's live Claude Code sessions enforce the full Write/Edit floor +
      worktree isolation (stale `.claude/hooks/` copy retired/repointed/shimmed);
      a test or documented verification proves `.claude/settings.json` resolves to
      the enforcing implementation.
- [x] Worktree-containment and `.ai-sdlc/**` floor checks realpath-resolve both
      sides; a hermetic test proves a symlink escaping the worktree is refused.
- [x] `warnIfStaleBase()` no longer spawns a git subprocess on every Write/Edit
      (cached/throttled); existing 49 hook tests still pass.

## Final Summary

## Summary
Retired the stale Bash-only `.claude/hooks/enforce-blocked-actions.*` copy and registered the plugin hook for `Write|Edit|MultiEdit` in `.claude/settings.json`, so this repository's own sessions get the Write/Edit floor and worktree isolation. The plugin hook now compares real paths on both sides of its containment checks, and `warnIfStaleBase()` is throttled through a cache file.

## Changes
- `.claude/hooks/enforce-blocked-actions.{js,sh,test.mjs}` (deleted): unregistered, Bash-only, fail-open dead copy.
- `.claude/settings.json` (modified): `Write|Edit|MultiEdit` PreToolUse matcher pointing at `ai-sdlc-plugin/hooks/enforce-blocked-actions.sh`.
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` (modified): `enforceWriteEdit()` realpath-resolves home, target and permittedExternalPaths (`realpathOrDeny` fails closed on `SymlinkCapError`); blockedPaths match on the real and the lexical path; untrusted floor checks both forms; stale-base check cached in a TTL cache file (`AI_SDLC_STALE_BASE_TTL_SECONDS`, `AI_SDLC_STALE_BASE_CACHE_DIR`).
- `ai-sdlc-plugin/hooks/settings-registration.test.mjs` (new), `enforce-blocked-actions.test.mjs` (modified): registration proof, symlink-escape, symlink-onto-blockedPaths, symlinked-root and throttle tests.
- `.claude/skills/ai-sdlc-governance/SKILL.md`, `ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md`, `docs/api-reference/governance.md`, `orchestrator/src/action-enforcement.test.ts` (modified): references repointed to the plugin hook.

## Design decisions
- **Delete rather than shim**: nothing registered the stale copy, so a shim would be a second dead file.
- **Deny if real OR lexical path matches blockedPaths**: keeps every existing match and adds the symlink-resolved one.
- **File cache for the stale-base check**: hooks run as a fresh process per call, so an in-process cache would never hit.

## Verification
- `node --test` hook suites: 382 passing; `action-enforcement.test.ts` 47 passing; lint and format:check clean.
- Reviews (code, test, security) approved with minor findings only.

## Follow-up
- declined: stale-base cache hardening against a pre-planted tmpdir symlink (CWE-59); the cache only gates a non-blocking advisory warning and macOS per-user TMPDIR is 0700
- declined: dedicated test for the `SymlinkCapError` deny branch in `realpathOrDeny`; the branch is fail-closed and covered by the pre-existing cap tests of `realpathDeepest`
