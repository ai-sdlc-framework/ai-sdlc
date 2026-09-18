---
id: AISDLC-626
title: Generalized reviewer-script bundle-parity gate
status: Done
priority: high
labels:
  - reviewers
  - plugin
  - ci
  - bug-prevention
created: 2026-09-18
---

## Context

AISDLC-562/#970 added `scripts/resolve-transcript-task-id.sh` and made every
Bash-capable reviewer agent `.md` (`code-reviewer`, `code-reviewer-codex`,
`correctness-reviewer`, `test-reviewer`, `test-reviewer-codex`) invoke it —
but the script was never copied into `ai-sdlc-plugin/scripts/`, the directory
that actually ships to adopters. Plugin scripts are manually duplicated: only
a couple exist in both `scripts/` and `ai-sdlc-plugin/scripts/`, each with
its own hand-written parity assertion (e.g. `check-attestation-sign.sh`'s
`test:plugin-attestation-sign-gate`). Adopter reviewer runs hit `exit 127`
(script not found) and every reviewer hard-refused before reading the diff —
no reviews, no attestation, nothing could ever merge. AISDLC-623 fixed that
ONE script (bundled the copy + a hand-written byte-parity test) but nothing
asserted the GENERAL property: "every plugin-root-resolved script a reviewer
`.md` references actually exists in the bundle." Nothing would have caught
the NEXT script added the same way.

## Scope

Add a hermetic gate, wired into `pnpm test`, that:

1. Scans every reviewer agent prompt under `ai-sdlc-plugin/agents/*.md` for
   scripts resolved via the `${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh` /
   `${CLAUDE_PLUGIN_DIR}/scripts/<name>.sh` candidate-list idiom (the pattern
   AISDLC-623 introduced for crossing the plugin-install boundary).
2. For every referenced script name, asserts a copy exists at
   `ai-sdlc-plugin/scripts/<name>.sh`, FAILING LOUDLY and naming both the
   missing script and the referencing `.md` file(s) when it does not.
3. Where a script legitimately exists in BOTH `scripts/` and
   `ai-sdlc-plugin/scripts/` (the manual-dup pattern, e.g.
   `resolve-transcript-task-id.sh`), asserts the two copies are
   byte-identical — mirroring the existing `check-attestation-sign.sh`
   parity idiom.
4. Deliberately does NOT flag plain `scripts/<name>.sh` references with no
   plugin-root candidate prefix (e.g. `developer.md`'s
   `scripts/check-backlog-drift-on-push.sh`, `rebase-resolver.md`'s
   `scripts/check-skip-ci-marker.sh`) — those run inside the dogfood
   monorepo's own worktree, not an adopter install, and are out of scope by
   design.
5. Generalizes as a ratchet: adding a new reviewer script or a new `.md`
   reference is covered automatically by the scan — no per-script
   hand-wiring required.

Follows the AISDLC-623 fix (merged) — that PR bundled the one script this
incident was about and added its own byte-parity test; this task generalizes
the assertion so the same class of bug cannot recur silently for any future
script.

## Acceptance Criteria

- [x] AC-1: A pure scan+assert implementation
      (`scripts/check-reviewer-script-bundle-parity.mjs`) extracts every
      `${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh` /
      `${CLAUDE_PLUGIN_DIR}/scripts/<name>.sh` reference from
      `ai-sdlc-plugin/agents/*.md` and returns a structured
      `{ ok, problems }` result — no `process.exit` in the importable
      surface, so tests can assert on the result directly.
- [x] AC-2: The gate FAILS, naming both the missing script name and every
      referencing `.md` file, when a referenced script does not exist under
      `ai-sdlc-plugin/scripts/`.
- [x] AC-3: The gate FAILS, naming the script, when a script exists in BOTH
      `scripts/` and `ai-sdlc-plugin/scripts/` but the two copies have
      drifted apart (not byte-identical).
- [x] AC-4: The gate does NOT flag plain `scripts/<name>.sh` references that
      lack the `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DIR}` prefix
      (dogfood-monorepo-only references stay out of scope).
- [x] AC-5: A live run of the gate against this repo's actual
      `ai-sdlc-plugin/agents/*.md` + `ai-sdlc-plugin/scripts/` passes
      (post-AISDLC-623 the resolver IS bundled and byte-identical) —
      proving the gate is a ratchet, not a big-bang failure.
- [x] AC-6: Wired into `pnpm test` as
      `test:reviewer-script-bundle-parity-gate`
      (`node --test scripts/check-reviewer-script-bundle-parity.test.mjs`).
- [x] AC-7: `pnpm build && pnpm test && pnpm lint && pnpm format:check`
      clean; `npx backlog-drift check` reports 0 errors.

## References

Root-cause incident: AISDLC-562/#970 (bug introduced) and AISDLC-623 (the
one-script fix this task generalizes). No RFC dependency — this is a CI-gate
addition scoped entirely to `scripts/` and `package.json`'s `test` chain.
