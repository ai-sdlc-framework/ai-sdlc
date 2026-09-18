---
id: AISDLC-625
title: Adopter-environment reviewer attribution smoke test
status: Done
priority: high
labels:
  - reviewers
  - ci
  - adopters
  - testing
created: 2026-09-18
---

## Context

AISDLC-562 (merged in #970) hardened the reviewer transcript-attribution
resolver to hard-refuse a review whenever no task attribution could be
resolved. In a consumer/adopter repo this bricked the entire pipeline: none
of the three attribution sources (`scripts/resolve-transcript-task-id.sh` at
the monorepo root, `.active-task`, `AI_SDLC_ACTIVE_TASK_ID`) exist outside
`/ai-sdlc execute`, so every reviewer refused before ever reading the diff —
no reviews, no attestation, nothing could merge.

CI in this monorepo never caught it because the monorepo always has
attribution: the resolver script lives at repo root, and `/ai-sdlc execute`
always writes `.active-task` before dispatching reviewers. The fail-closed
branch that broke adopters was simply never exercised here.

Follows the AISDLC-623 fix (merged): the resolver now fails SOFT (synthesizes
a unique `UNKNOWN-<reviewer>-<timestamp>-<random>` id and exits 0 instead of
refusing) and the script is bundled into `ai-sdlc-plugin/scripts/` so it
actually reaches adopter plugin installs. This task adds the missing
automated detection so a regression of this class fails CI instead of an
adopter's pipeline.

## Scope

Add a hermetic smoke test (`scripts/adopter-reviewer-attribution-smoke.test.mjs`)
that reproduces the adopter/consumer environment and asserts the reviewer
attribution resolution fails SOFT, not closed:

1. A mkdtemp'd "consumer repo" dir with no `.active-task`, no
   `AI_SDLC_ACTIVE_TASK_ID`, and no monorepo-relative
   `scripts/resolve-transcript-task-id.sh` — the exact adopter condition
   AISDLC-562/#970 broke.
2. Invokes the **bundled** `ai-sdlc-plugin/scripts/resolve-transcript-task-id.sh`
   the way an adopter's plugin install would reach it, via
   `$CLAUDE_PLUGIN_ROOT` / `$CLAUDE_PLUGIN_DIR`, from the consumer-repo cwd.
3. Asserts the resolver exits 0 and prints a unique `UNKNOWN-<reviewer>-...`
   id satisfying the transcript-directory path-shape guard
   `^[A-Za-z0-9][A-Za-z0-9._-]*$` — not exit 1/127, not a refusal.
4. Asserts the bundled copy exists and is executable (defense-in-depth
   against the "script not shipped" root cause).
5. Asserts the reviewer `.md` Step 0 CANDIDATES resolution-chain logic
   (`$CLAUDE_PLUGIN_ROOT` → `$CLAUDE_PLUGIN_DIR` → monorepo-relative
   `scripts/`) picks the plugin-bundled script when only the plugin env vars
   are set and no monorepo-relative script exists in cwd — covering the
   "hardcoded repo-root path" root cause directly, since extracting and
   executing the full agent `.md` bash block (which also does transcript
   bookkeeping unrelated to attribution) was judged too fiddly for a
   hermetic gate.

Wired into `pnpm test` as a new `test:adopter-reviewer-attribution-smoke-gate`
script, mirroring the existing `test:transcript-attribution-gate` and other
`test:*-gate` entries — no CI workflow edit needed since `pnpm test` already
runs in the CI "Build & Test" job.

## Acceptance Criteria

- [x] AC-1: `scripts/adopter-reviewer-attribution-smoke.test.mjs` reproduces a
      no-attribution consumer-repo environment (mkdtemp cwd, no
      `.active-task`, no `AI_SDLC_ACTIVE_TASK_ID`, no monorepo-relative
      resolver script) and invokes the bundled
      `ai-sdlc-plugin/scripts/resolve-transcript-task-id.sh` via
      `$CLAUDE_PLUGIN_ROOT`.
- [x] AC-2: The test asserts the resolver exits 0 (not 1/127) and prints a
      unique `UNKNOWN-<reviewer>-...` id matching the transcript path-shape
      guard — this is the exact contract #970 violated and AISDLC-623
      restored.
- [x] AC-3: A companion assertion confirms the bundled resolver exists on
      disk and is executable.
- [x] AC-4: A companion assertion covers the reviewer `.md` Step 0
      CANDIDATES resolution-chain logic, confirming it resolves to the
      plugin-bundled script (not a monorepo-relative path) when only plugin
      env vars are set.
- [x] AC-5: New gate wired into the root `package.json` `test` chain as
      `test:adopter-reviewer-attribution-smoke-gate`, mirroring the shape of
      sibling `test:*-gate` entries.
- [x] AC-6: `pnpm test:adopter-reviewer-attribution-smoke-gate`,
      `pnpm lint`, `pnpm format:check`, and `npx backlog-drift check` are
      clean.

## References

Regression context: AISDLC-562 (#970) hardened reviewer transcript
attribution to hard-refuse; this broke every adopter/consumer repo pipeline
because the monorepo's own CI never exercises the no-attribution branch.
Follows the AISDLC-623 fix (merged), which restored fail-soft behavior and
bundled the resolver script into the plugin. This task adds only the missing
automated regression coverage — no behavior change to the resolver itself.
