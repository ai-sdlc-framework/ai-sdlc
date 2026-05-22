---
id: AISDLC-386
title: 'chore: collapse pre-push "re-push required" chain into single mechanical-fixups pass'
status: To Do
labels:
  - architecture
  - hooks
  - operator-ux
references:
  - .husky/pre-push
  - scripts/check-task-moved.sh
  - scripts/check-mcp-bundle-sync.sh
  - scripts/squash-attestation-chores.sh
  - scripts/check-attestation-sign.sh
  - docs/operations/gate-friction-audit-2026.md
parentTaskId: AISDLC-384
---

## Description

Surfaced by the AISDLC-384 gate-friction audit (Gate 6 review of `check-attestation-sign.sh`).

The pre-push chain has multiple hooks that exit-1 with "re-run git push" semantics:

1. `scripts/check-coverage.sh` — never exit-1 (just fail or pass)
2. `scripts/check-task-moved.sh` — exit-1 after auto-mv + chore commit
3. `scripts/check-mcp-bundle-sync.sh` — exit-1 after rebuild + chore commit (will DELETE per AISDLC-385)
4. `scripts/squash-attestation-chores.sh` — silent (no exit-1)
5. `scripts/check-dor-gate.sh` — never exit-1 (just fail or pass)
6. `scripts/check-attestation-sign.sh` — exit-1 after sign + chore commit

Worst case the operator runs `git push` THREE TIMES sequentially:
- Push 1 → task-moved hook fires → chore commit → exit 1 → "re-run"
- Push 2 → mcp-bundle-sync fires (if pipeline-cli/src touched) → chore commit → exit 1 → "re-run" (this case goes away with AISDLC-385)
- Push 3 → attestation-sign fires → chore commit → exit 1 → "re-run"
- Push 4 → all clean → actual push to remote

Each exit-1 is intentional (the chore commit must land BEFORE the next hook in the chain to satisfy attestation contentHash ordering), but the COMPOUND cost is real UX friction.

## Architectural proposal

Add a thin **orchestrator hook** at the top of `.husky/pre-push` that:

1. Runs all "mechanical fixups" in dependency order: task-move → mcp-bundle-sync (if not deleted by 385) → attestation-sign
2. Each fixup writes its chore commit but does NOT exit-1
3. After all fixups complete, the orchestrator hook exits 1 ONCE with a consolidated "re-run git push" message listing what was fixed
4. Existing hooks retain their AISDLC-220 / AISDLC-357 / AISDLC-133 exit-1 paths for backward compat (so direct invocation still works), but the orchestrator pre-empts them in chain mode

End-user experience: at most TWO pushes (one to trigger fixups, one to actually send). Operators who already have all chores landed see exactly ZERO extra pushes.

## Acceptance criteria

- [ ] AC-1: New script `scripts/pre-push-fixups.sh` orchestrates: task-move → (mcp-bundle-sync if 385 not shipped) → attestation-sign in dependency order. Each sub-hook is invoked via an internal mode flag (e.g. `INTERNAL_NO_EXIT_1=1`) that suppresses the exit-1 but still does the work.
- [ ] AC-2: After all fixups, if any chore commits were made, exit 1 ONCE with a consolidated summary message: `[pre-push-fixups] Auto-fixed: <list>. Re-run \`git push\` to send.`
- [ ] AC-3: If no fixups were needed, exit 0 silently — no operator-visible delay.
- [ ] AC-4: `.husky/pre-push` updated to invoke the orchestrator after coverage + DoR gates (which can fail) but BEFORE any chore commits would normally happen.
- [ ] AC-5: Existing hooks retain their standalone exit-1 behavior when invoked directly (e.g. `bash scripts/check-task-moved.sh`) — orchestrator suppression is opt-in via env var.
- [ ] AC-6: Hermetic tests for the orchestrator: covers all 8 combinations (task-move needed yes/no × bundle-sync needed yes/no × attestation-sign needed yes/no) — orchestrator exits 1 only when ≥1 fixup ran.
- [ ] AC-7: Operator runbook entry in `docs/operations/emergency-bypass.md` clarifying that the master bypass `AI_SDLC_BYPASS_ALL_GATES=1` skips the orchestrator + all sub-hooks.
- [ ] AC-8: CLAUDE.md "Hooks" section updated to reflect the orchestrator at the top + simpler sub-hook descriptions (no longer separately listing exit-1 semantics for each).
- [ ] AC-9: Update `docs/operations/gate-friction-audit-2026.md` to note this UX improvement shipped.

## Risks + mitigations

- **Order matters (load-bearing)**: task-move MUST run before attestation-sign (per AISDLC-220 contentHashV4 binding). The orchestrator must preserve this. Mitigation: orchestrator hardcodes order; hermetic test covers the ordering invariant.
- **Failure in one fixup masks subsequent fixups**: if task-move fails, should attestation-sign still run? Mitigation: orchestrator runs sub-hooks until first hard-failure, then exits with the failed hook's exit code (not exit-1). Soft-failures (the normal exit-1 "I did work") cumulate.
- **Operator debugging**: when orchestrator fires, individual hook logs aren't separately visible. Mitigation: orchestrator prepends each sub-hook's output with `[<hook-name>]` prefix.
- **Interaction with AISDLC-385**: when 385 lands, `check-mcp-bundle-sync.sh` is deleted; the orchestrator must be updated to remove its invocation in the same PR. Mitigation: file 386 to land AFTER 385 to keep this clean. (If 385 hasn't shipped when 386 is implemented, include mcp-bundle-sync; otherwise omit.)

## Estimated effort

1-2 days implementation. Mostly bash + hermetic test infrastructure.

## Out of scope

- Refactoring individual hooks beyond the suppression flag
- Changing `.husky/pre-push` chain ORDER (preserve as-is, just orchestrate)
- v6-related signing changes (RFC-0042 territory)

## References

- AISDLC-220 — origin task-moved hook
- AISDLC-357 — origin mcp-bundle-sync hook (likely deleted by AISDLC-385)
- AISDLC-133 — origin attestation-sign hook
- AISDLC-369 — origin squash-attestation-chores hook
- AISDLC-370 — origin dor-gate hook
- [Gate friction audit § Gate 6](docs/operations/gate-friction-audit-2026.md#gate-6) — surfaced this UX concern
