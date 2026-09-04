---
id: aisdlc-571
title: verdictClass is always self-authored — canonical plugin manifest never registers the SubagentStart hook
status: Done
priority: high
labels:
  - bug
  - plugin
  - attestation
  - aisdlc-568-followup
references:
  - AISDLC-568
---

## Description

AISDLC-568 added `verdictClass: 'independent' | 'self-authored'` to v6 attestation
leaves. `determineVerdictClass()` (`pipeline-cli/src/attestation/verdict-class.ts`)
decides the value by looking for a marker file under `.ai-sdlc/subagent-sessions/`,
written by `ai-sdlc-plugin/hooks/subagent-start.js` (via `subagent-start.sh`) on the
`SubagentStart` event. That event fires ONLY when the harness dispatches a real
subagent through the `Agent`/`Task` tool — which is the whole point: a coordinator
running the reviewer Bash by hand can't fire it, so its leaf can't claim `independent`.

**Bug: the CANONICAL marketplace manifest `ai-sdlc-plugin/.claude-plugin/plugin.json`
never registers `SubagentStart`.** Its `hooks` block has only:
`SessionStart, PreToolUse, PostToolUse, Stop, PermissionRequest` — no `SubagentStart`
(`grep -c SubagentStart ai-sdlc-plugin/.claude-plugin/plugin.json` → 0). The ROOT
`ai-sdlc-plugin/plugin.json` DOES register it (→ `subagent-start.sh`, which exists),
so the two manifests have drifted — the marketplace-installed plugin (what consumers
load) never fires the hook.

### Impact
- `.ai-sdlc/subagent-sessions/` is never created; no markers are written.
- `determineVerdictClass` hits its fail-safe on every call → **every leaf is
  `self-authored`**; `overallVerdictClass` (weakest-link) is always `self-authored`;
  the `'independent'` branch is UNREACHABLE in the shipped config. AISDLC-568's core
  distinction (independent reviewer vs coordinator self-review) cannot be drawn.
- **Second latent regression:** `subagent-start.js` also injects `agent-role.yaml`
  governance as `additionalContext` into spawned subagents. If the hook is unregistered
  in the canonical manifest, that governance injection is ALSO not happening for
  marketplace-installed consumers — confirm and fix.

This is the same manifest-drift class as AISDLC-558 (`.claude-plugin/plugin.json` vs
`plugin.json`). Reviewers of AISDLC-568 (#986) reviewed the code diff, not the manifest
wiring, so it slipped through — hence the conformance test below.

## Scope

1. Register `SubagentStart` in `ai-sdlc-plugin/.claude-plugin/plugin.json`, mirroring
   the root `plugin.json` entry (command `bash "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-start.sh"`),
   matching the form of the existing SessionStart/PreToolUse entries. Confirm the two
   manifests are otherwise in sync for hooks (reconcile any other drift found).
2. Verify end-to-end that `subagent-start.sh` → `subagent-start.js` actually writes
   `.ai-sdlc/subagent-sessions/<id>.json` when a real subagent is dispatched, and that
   `determineVerdictClass` then returns `independent` for a leaf whose transcript mtime
   falls in the marker window.
3. Confirm the agent-role.yaml governance-injection responsibility of the hook works
   once registered (or note it's covered elsewhere).
4. Bump nothing manually — release-please handles the plugin version bump on merge so
   consumers get the fix.

## Acceptance Criteria

- [x] `ai-sdlc/.claude-plugin/plugin.json` registers `SubagentStart` → `subagent-start.sh`;
      `grep -c SubagentStart ai-sdlc-plugin/.claude-plugin/plugin.json` ≥ 1.
- [x] Both plugin manifests agree on the set of registered hook events (no drift).
- [x] A **plugin-conformance test** asserts that every hook event whose script ships
      under `ai-sdlc-plugin/hooks/` is registered in BOTH manifests — it must FAIL on
      the current (pre-fix) state (an unregistered shipped hook), pass after the fix.
- [x] An integration test proving the full path: a dispatched subagent writes a marker
      and `determineVerdictClass` returns `independent` for a leaf in the marker window
      (not just the unit-level fail-safe already covered by AISDLC-568).
- [x] Governance-injection (agent-role.yaml additionalContext) into subagents is
      confirmed working once the hook is registered.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note (deeper property — out of scope here)

Even fully wired, `verdictClass` remains a same-machine heuristic (a coordinator with
Bash/Write can fabricate a marker). That limit is tracked as DEC-0012 / [[aisdlc-570]]
(bind the leaf to the reviewer's harness-captured transcript). THIS task is strictly
prior and narrower: make the shipped feature reach even its heuristic value by firing
the producing hook.

## Final Summary

Fixed the manifest drift: added the `SubagentStart` hook entry to
`ai-sdlc-plugin/.claude-plugin/plugin.json` (the marketplace-canonical manifest),
mirroring the root `ai-sdlc-plugin/plugin.json` entry exactly. While diffing the two
manifests' `hooks` blocks per the task's "reconcile ANY other drift" instruction, also
found and fixed a second drift: the root manifest's `PreToolUse` block has a second
matcher entry (`Write|Edit` → `enforce-blocked-actions.sh`, the write-policy check)
that the canonical manifest was also missing — only the `Bash` matcher was present
there. Both manifests now have byte-identical `hooks` blocks.

Verified end-to-end by invoking `subagent-start.sh`/`subagent-start.js` as a real
`SubagentStart` firing would (piping a JSON stdin payload, setting
`CLAUDE_PROJECT_DIR`): confirmed the marker is written to
`.ai-sdlc/subagent-sessions/<id>.json` and that `determineVerdictClass()` returns
`'independent'` for a transcript mtime in the marker window. Also confirmed the
governance-injection responsibility (agent-role.yaml → additionalContext) fires
correctly in the same invocation.

Added two required tests:
- **Plugin-conformance test** (`ai-sdlc-plugin/scripts/install-runtime-deps.test.mjs`,
  new describe block): generalizes the AISDLC-554 runtimeDependencies-sync pattern to
  the `hooks` block — asserts every hook event backed by a script that actually ships
  under `ai-sdlc-plugin/hooks/` is registered in BOTH manifests. Verified this test
  FAILS on the pre-fix state (`git stash` the manifest fix, re-run — 2 failures citing
  the missing `SubagentStart` event) and PASSES after unstashing.
- **Integration test** (`pipeline-cli/src/attestation/verdict-class.integration.test.ts`,
  new file): spawns the real `subagent-start.js` hook script as a child process (not a
  hand-synthesized marker, which is what the existing AISDLC-568 unit tests do) and
  asserts the resulting on-disk marker drives `determineVerdictClass()` to
  `'independent'`, plus a negative-control test proving no-marker still falls back to
  `'self-authored'`.

AISDLC-558 (still open, `To Do`) covers the broader structural-prevention question for
this class of manifest drift — which manifest the marketplace installer actually reads,
and whether the two files should be generated from one source or one deleted entirely.
This task deliberately stayed narrow: fix the specific regression + add regression
tests, per its own scope statement. AISDLC-558 remains the right place for that
follow-up architectural work.

### Verification
- `pnpm build` — clean (built via Node v22.23.2 to satisfy `lint-staged@17`'s
  `engines.node >=22.22.1`; the ambient Node in the worktree was v22.19.0).
- `pnpm test` — 205+312 test files pass across the workspace; one pre-existing flaky
  test (`pipeline-cli/src/tui/use-terminal-dimensions.test.tsx`, a known
  timing-sensitive TUI resize smoke test unrelated to this change) failed under full
  parallel run and passed cleanly in isolation — not touched by this diff.
- `pnpm lint` — clean.
- `pnpm format:check` — clean.
