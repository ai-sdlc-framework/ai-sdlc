---
id: AISDLC-1146
title: 'Pre-push governance gate: the backlog-drift step blocks on the tool exit code (warnings), while CI blocks on error-severity findings only'
status: To Do
assignee: []
created_date: '2026-10-31'
labels:
  - pre-push
  - governance-gate
  - backlog-drift
  - main-health
dependencies: []
references:
  - scripts/check-governance-on-push.sh
  - scripts/check-governance-on-push.test.mjs
  - .github/workflows/ai-sdlc-gate.yml
priority: high
dispatchable: true
---

## Description

`scripts/check-governance-on-push.sh` runs `npx backlog-drift@0.1.3 check` whenever a push removes or renames a file that `backlog/` references, and blocks the push when that command exits non-zero. `backlog-drift check` exits 1 whenever it has anything to report, including info and warning items such as "Dependency X has been completed" and "Referenced file Y was modified after task was completed". On 2026-10-31 it exits 1 on `origin/main` itself with zero error-severity findings. So today every push that deletes a backlog-referenced file is blocked by the pre-push gate, whatever the branch did.

The CI gate (`ai-sdlc-gate.yml`, job `backlog-drift`, "full repo, error-severity gate") already does the right thing: it runs `check --json`, counts findings with `severity: error`, fails only when that count is above zero or the report is not valid JSON, and prints info and warning items as informational. The pre-push copy of the gate (AISDLC-1123) was meant to be an early copy of CI, not a stricter one.

Observed: AISDLC-1142 (deletes `scripts/sync-plugin-runtime-deps.mjs`, the DEC-0278 change that turns main-health green) was reviewed and signed twice and could not be pushed from its executor nor from the planner session (2026-10-31, worktree `.worktrees/aisdlc-1142`, head ff41d87c); the gate log ends in `[governance-gate] backlog drift: fix with npx backlog-drift fix --task <id>` with only ℹ and ⚠ lines above it. The same block caught its first attempt earlier the same day ("59 unrelated 'Dependency X has been completed' issues").

## Fix

**Five-step review (requirements first).** Requirement questioned: must a pre-push gate block on anything CI would let through? No: the pre-push gate is an early copy of the CI gate, so it must block exactly when CI would, on error-severity drift findings. Deletion: the plain exit-code test on `backlog-drift check` goes away. Simplified: the drift step reads the `--json` report and counts `severity: error` findings, the same rule CI applies, so one definition of "drift that blocks" exists. Accelerated: the drift step still runs only when a removed or renamed backlog-referenced file is in the push range, so docs-only and ordinary pushes stay as fast as today. Automated: the test file covers the three outcomes (warnings only passes, one error blocks, invalid JSON blocks) so the two gates cannot drift apart silently again.

Implementation in `scripts/check-governance-on-push.sh`:

1. Keep the trigger (a removed or renamed file referenced from `backlog/`).
2. Run `npx backlog-drift@0.1.3 check --json </dev/null > "$report" 2>/dev/null || true` into a temp file.
3. Block when the report is not valid JSON (print the tool's exit code) or when the count of findings with `severity == "error"` is above zero; print that count and the warning count the way CI does (same JSON path as the CI step, so the two cannot disagree on shape).
4. Print info and warning items as informational and let the push continue.

Keep the human-readable `npx backlog-drift check` output on a block so the pusher sees which task to fix.

## Acceptance Criteria

- [ ] AC-1: With a report holding only info and warning findings (tool exit 1), the gate does not block the push; the log says the gate passed and that info and warning items are informational.
- [ ] AC-2: With at least one `severity: error` finding, the gate blocks and names the fix command, as today.
- [ ] AC-3: With an unreadable report (not valid JSON), the gate blocks and prints the tool exit code, mirroring the CI step.
- [ ] AC-4: `scripts/check-governance-on-push.test.mjs` covers AC-1 to AC-3 with a stubbed `npx` on `PATH` or an equivalent injection already used by that test file; no live `npx` call in tests.
- [ ] AC-5: The CI job in `ai-sdlc-gate.yml` is unchanged; the counting rule in the script matches the CI step's JSON path.
- [ ] AC-6: `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.
