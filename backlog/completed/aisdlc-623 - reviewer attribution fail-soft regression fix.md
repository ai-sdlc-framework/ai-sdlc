---
id: AISDLC-623
title: Reviewer transcript attribution must fail SOFT (unique UNKNOWN dir), not refuse the review
status: Done
priority: high
labels:
  - reviewers
  - attestation
  - adopters
  - bug
created: 2026-09-18
---

## Context

Regression over the AISDLC-562 hardening (merged in #970). AISDLC-562 was a
legitimate fix: it stopped reviewer subagents from writing their transcripts to
a shared `.ai-sdlc/transcripts/UNKNOWN/` directory, because two unrelated runs
writing that same path silently overwrote each other's evidence. The fix it
shipped was to REFUSE the review outright (write nothing, exit 1) whenever the
run could not be attributed to a task.

That refusal over-reached. In a consumer/adopter repo — or in ANY reviewer
dispatch not routed through `/ai-sdlc execute` — none of the three attribution
sources exist:

1. `scripts/resolve-transcript-task-id.sh` lived ONLY at the monorepo root
   `scripts/`; it was never bundled into `ai-sdlc-plugin/scripts/`, and the
   reviewer `.md` files hardcoded the repo-root-relative path
   `bash scripts/resolve-transcript-task-id.sh`, which is exit 127 (not found)
   in an adopter repo.
2. `<worktree>/.active-task` is only written by the `/ai-sdlc execute`
   orchestrator.
3. `$AI_SDLC_ACTIVE_TASK_ID` is not visible to no-Bash subagents
   (`security-reviewer`).

Result: every reviewer returned `critical: review refused` at Step 0 BEFORE
reading the diff — no reviews, no attestation, the PR can never reach green,
nothing merges. A HIGH-severity regression blocking all adopters.

## Key insight

The review analysis itself (finding bugs) never needed task attribution at
all. `.ai-sdlc/transcripts/<task-id>/<reviewer>.jsonl` (the reviewer
conversation log consumed by the reconciler) is a DIFFERENT artifact from
`.ai-sdlc/transcript-leaves/<patch-id>.jsonl` (the Merkle input consumed by the
signer). AISDLC-562's ONLY real concern was the *shared* `UNKNOWN` path
colliding across runs — not the absence of attribution itself.

## Scope

1. `scripts/resolve-transcript-task-id.sh` — restore fail-soft behavior for
   the missing-attribution case: instead of `exit 1`, synthesize and print a
   UNIQUE `UNKNOWN-<reviewer>-<UTC-timestamp>-<random>` id and `exit 0`. Keep
   the strict path-shape guard as a HARD refusal only for a malformed
   *present* attribution value (e.g. `.active-task` containing `../evil` or a
   `/`) — that remains a genuine misconfiguration.
2. Bundle the script into `ai-sdlc-plugin/scripts/resolve-transcript-task-id.sh`
   (byte-identical to the monorepo copy) so it actually reaches adopter repos,
   and update the 5 reviewer `.md` files (`code-reviewer`,
   `code-reviewer-codex`, `correctness-reviewer`, `test-reviewer`,
   `test-reviewer-codex`) to resolve the script portably across install
   topologies (`$CLAUDE_PLUGIN_ROOT`, then `$CLAUDE_PLUGIN_DIR`, then the
   monorepo-relative `scripts/` path), falling back to synthesizing a unique
   id inline if no resolver script is found at all. A resolved id is persisted
   to a per-reviewer marker file so the Step 0 and Step END transcript writes
   agree on the same directory within one review run.
3. `ai-sdlc-plugin/agents/security-reviewer.md` (no Bash tool) — change the
   missing-`.active-task` case from a hard refusal to proceeding with a unique
   `UNKNOWN-security-reviewer-<ISO-timestamp-no-colons>` transcript directory.
4. Add a read-only `ai-sdlc doctor` check (`reviewer-attribution-resolver`)
   that WARNs (never fails) when the resolved plugin install is missing
   `scripts/resolve-transcript-task-id.sh`, pointing at a plugin
   reinstall/update as the remediation.
5. Hermetic tests for the fail-soft-unique contract (real id still resolves;
   missing attribution now proceeds with a unique id and exit 0; two
   consecutive unattributed calls produce different ids; a malformed present
   id still exits 1) plus a doctor-check test for the present/absent bundle
   case.

## Acceptance Criteria

- [x] AC-1: A reviewer run with no `.active-task` and no
      `AI_SDLC_ACTIVE_TASK_ID` set proceeds with the review instead of
      refusing, writing its transcript under a unique
      `UNKNOWN-<reviewer>-<timestamp>-<random>` directory.
- [x] AC-2: Two separate unattributed reviewer runs never write to the same
      transcript directory (the AISDLC-562 no-collision property is
      preserved by uniqueness, not by refusal).
- [x] AC-3: A malformed *present* attribution value (`.active-task` containing
      `../evil` or a `/`) still hard-refuses with exit 1 — that
      misconfiguration case is unchanged.
- [x] AC-4: `resolve-transcript-task-id.sh` is bundled identically under
      `ai-sdlc-plugin/scripts/`, and all 5 Bash-capable reviewer `.md` files
      resolve it via the plugin-relative path first, falling back to the
      monorepo-relative path, falling back to an inline unique id when no
      resolver script is found at all.
- [x] AC-5: `security-reviewer.md` (no Bash tool) proceeds with a unique
      unattributed transcript directory instead of refusing when
      `.active-task` is absent.
- [x] AC-6: `ai-sdlc doctor` surfaces a WARN (not a fail) when the resolved
      plugin install is missing the reviewer-attribution resolver script.
- [x] AC-7: Hermetic test coverage for all of the above;
      `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean;
      `npx backlog-drift check` reports 0 errors.

## References

Regression over the AISDLC-562 hardening (merged in #970). Root-cause analysis
above; fix scoped to reviewer transcript attribution and plugin bundling only
— the attestation signer/verifier trust boundary is unchanged.
