---
id: AISDLC-105
title: rebase-resolver subagent + /ai-sdlc rebase slash command
status: Done
assignee: []
created_date: '2026-05-01 03:45'
labels:
  - plugin
  - subagent
  - rebase
  - developer-experience
  - automation
dependencies: []
references:
  - ai-sdlc-plugin/agents/
  - ai-sdlc-plugin/commands/
  - scripts/check-skip-ci-marker.sh
priority: high
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: 'Referenced file no longer exists: scripts/sign-attestation.mjs'
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced 2026-05-01 during the AISDLC-101 + AISDLC-88 + AISDLC-100.1 batch. The orchestrator (Claude main session) ended up doing 6+ manual rebase + conflict-resolution rounds across PRs #113, #114, #115 — all mechanical work. AISDLC-88's PR #115 alone needed three separate rebase rounds because main kept moving while the PR was in flight. Cumulative friction is significant + the work is delegable.

## What this task ships

A new `rebase-resolver` plugin subagent + a `/ai-sdlc rebase <pr-number>` slash command that wraps it.

The subagent's contract: take a PR number or branch name, fetch latest main, rebase, attempt conflict resolution against project rules, run verification (build + test + lint + format), force-push with `--force-with-lease`, return structured JSON outcome.

## Conflict resolution rules (the 80% the subagent handles automatically)

1. **CHANGELOG `Unreleased > Added` overlaps** — both branches added new bullet entries to the same section. Always keep BOTH (different features). Order by the timestamp of when the entry was first introduced (earliest first).
2. **Test file additions to the same describe block** — both branches added new `it(...)` cases to the same `describe(...)`. Keep both, no semantic conflict.
3. **Code additions to the same file (non-overlapping line ranges)** — git's auto-merge usually handles this, but flag if the additions are textually adjacent.
4. **Prettier formatting drift after manual edit** — run `pnpm exec prettier --write <file>` on every conflict-resolved file before continuing the rebase. This was the root cause of PR #115's iteration 4 CI failure.
5. **`--force-with-lease`, never `--force`** — and never on `main`/`master` (matches existing CLAUDE.md rule).

## What the subagent escalates back (the 20% needing judgment)

1. **Modify-vs-delete conflicts** (file deleted on main, modified on branch) — needs a port to a new location, which requires understanding architectural intent. Escalate with: "File X was deleted by Y; your changes need to be ported to <best-guess-new-home>. Confirm or override."
2. **Content semantic conflicts** — both branches modified the same lines with substantively different intent. Don't try to merge; return both versions with diff context.
3. **Verification failures after resolution** — build/test/lint/format failures after the resolution. Return the failing output verbatim, do NOT push.
4. **Iteration cap exceeded** — after 3 rebase attempts (each may need conflict resolution), if main is still moving faster than we can rebase, escalate.

## Composition with /ai-sdlc execute

The slash command body should:
1. Run Step 0-2 (validate task, compute branch — same as existing `/ai-sdlc rebase` runs against existing PR + worktree, so most setup steps skip)
2. Locate the PR's worktree at `.worktrees/<task-id-lower>` (must exist; if not, recreate from origin)
3. Invoke the `rebase-resolver` subagent against that worktree
4. On success: re-run the AISDLC-87 attestation signing (the rebase changed HEAD, so the existing attestation needs refresh — except where AISDLC-101 v3 leg accepts the rebase content-hash unchanged; the helper should use the `--print-content-hash` oracle to decide)
5. Force-push + report

## Acceptance Criteria

1. New plugin subagent at `ai-sdlc-plugin/agents/rebase-resolver.md` with system prompt covering the rules above
2. New slash command at `ai-sdlc-plugin/commands/rebase.md` invoking the subagent + handling re-attestation
3. Subagent returns structured JSON: `{ outcome: 'success' | 'escalated' | 'failed', resolvedFiles: [...], escalationReason?: string, verifications: { build, test, lint, format } }`
4. Conflict resolution rules implemented for the 5 cases listed above; tested against fixture conflict scenarios
5. Verification chain: `pnpm build && pnpm test && pnpm lint && pnpm format:check` runs after resolution; failure → escalate (do NOT push)
6. Force-push uses `--force-with-lease` and refuses on `main`/`master` (mirrors existing rule in agent-role.yaml)
7. Re-signs attestation after rebase ONLY when contentHash changed (use `sign-attestation.mjs --print-content-hash` oracle from AISDLC-102)
8. Tests: 8+ fixture conflict scenarios covering CHANGELOG overlap, test additions, modify-vs-delete escalation, prettier drift, verification-failure escalation, force-with-lease refusal, attestation refresh
9. Document in CLAUDE.md the new pattern + when operator should invoke `/ai-sdlc rebase <pr>` manually
10. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean

## References

- PR #113 (AISDLC-69.3) — first conflict, CHANGELOG only
- PR #114 (AISDLC-101) — CHANGELOG + test file
- PR #115 (AISDLC-88) — three iterations: CHANGELOG → modify-vs-delete (needed port) → prettier-drift CI failure
- AISDLC-102 — Step 10.5 pre-sign rebase + `--print-content-hash` oracle
- AISDLC-87 — CI-side attestor (precedent for cloud-side attestation)
- AISDLC-101 — verifier per-file delta hashing (decides when re-attestation is needed)
- CLAUDE.md "Git Flow" section
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

New `rebase-resolver` plugin subagent + `/ai-sdlc rebase <pr-number>` slash command that automates the mechanical 80% of PR rebase + conflict resolution and escalates the architectural 20% (modify-vs-delete, semantic conflicts, verification failures, iteration cap exceeded). Solves the friction we hit 6× in this very session across PRs #113, #114, #115. Composes with future AISDLC-106 (GH Actions auto-trigger) and AISDLC-107 (Slack escalation surface) to close the auto-rebase loop without human-in-the-loop for routine cases.

## Changes

- `ai-sdlc-plugin/agents/rebase-resolver.md` (new) — plugin subagent with system prompt covering 5 mechanical rules + 4 escalation cases, single-level (no Agent tool, can't spawn nested)
- `ai-sdlc-plugin/agents/rebase-resolver.test.mjs` (new) — 47+ assertions covering rules + escalation cases + return contract
- `ai-sdlc-plugin/commands/rebase.md` (new) — slash command body invoking subagent, handling re-attestation oracle, owning the single push site
- `ai-sdlc-plugin/commands/rebase.test.mjs` (new) — 38+ assertions on body shape + push consolidation + re-attestation flow
- `ai-sdlc-plugin/agents/agents.test.mjs` (modified) — added `rebase-resolver.md` to `agentFiles` array so project-wide invariants (`disallowedTools: AgentTool`, `Read` in tools, model:inherit, name+description) gate the new agent
- `CLAUDE.md` — new `### Automated rebase via /ai-sdlc rebase <pr> (AISDLC-105)` subsection under `## Git Flow` documenting when to invoke + what's auto vs escalated
- `ai-sdlc-plugin/CHANGELOG.md` — entry under `Unreleased > Added`

## AC status

- ✓ All 10 ACs met across 2 iterations

## Design decisions

- **Mechanical/architectural split**: the 5 rules (CHANGELOG keep-both, test-additions keep-both, code-additions adjacency, prettier drift, force-with-lease + main/master refusal) are textual / deterministic — safe for unattended automation. The 4 escalation cases require judgment (modify-vs-delete = port to new home, semantic conflict = which intent wins, verification failure = root cause, iteration cap = something deeper is wrong) — kicked back to operator with structured context.
- **Single push owner** (round 2 fix): originally both subagent Stage 6 and slash command Step 6 pushed → race + duplicate CI runs. Consolidated to slash command being the sole push site; subagent's Stage 6 is now a return-stage. Test asserts EXACTLY 1 executable push.
- **BSD-portable sed** (round 2 fix): original `+?` non-greedy quantifier rejected by macOS BSD sed (CRITICAL caught by code reviewer). Replaced with `[a-z]+-[0-9.]+` portable pattern; verified against 4 canonical branch shapes including `aisdlc-100.2` (decimal).
- **Step 5 fall-through** (round 2 fix): originally `exit 0` on contentHash-unchanged path stranded rebased commits unpushed (MAJOR). Now uses `if/else` so flow falls through to Step 6 cleanly.
- **/tmp persistence** (round 2 fix): originally Step 5 read `/tmp/rebase-resolver-${PR}.json` that no step wrote (MAJOR — re-attestation oracle never fired). Added explicit heredoc write step between Step 4 and Step 5, with single-quoted heredoc tag for safety.
- **Iteration + harness fidelity** (round 2 fix): re-sign now reads `iterationCount` + `harnessNote` from the pre-rebase attestation envelope at `.ai-sdlc/attestations/<old-head-sha>.dsse.json` instead of hard-coding to defaults. Preserves audit-trail integrity across rebases.
- **AISDLC-101 v3 leg integration**: re-attestation only fires when `contentHash` actually changed (uses `sign-attestation.mjs --print-content-hash` oracle from AISDLC-102). When rebase didn't move any blob SHA at HEAD, the existing attestation still verifies — no re-sign needed.

## Verification

- `pnpm build` — clean
- `node --test ai-sdlc-plugin/agents/rebase-resolver.test.mjs` — 47/47
- `node --test ai-sdlc-plugin/commands/rebase.test.mjs` — 38/38
- `node --test ai-sdlc-plugin/agents/agents.test.mjs` — full plugin invariant gate green (now includes rebase-resolver.md)
- Combined: 120 tests across 3 files all pass; full plugin suite 287 tests, no regressions
- `pnpm test` (full workspace) — clean
- `pnpm lint`, `pnpm format:check` — clean
- 2 review iterations:
  - Round 1: 1 CRITICAL (BSD sed `+?`) + 3 MAJOR (Step 5 exit 0 strands commits, dual push owners, /tmp file no step writes) + 3 minor + 1 suggestion — caught by code-reviewer
  - Round 2: addressed CRITICAL + 3 MAJOR + 3 minors → all 3 reviewers APPROVED (code 0c/0M/1m/0s pre-existing; test 0c/0M/1m/2s; security 0c/0M/0m/0s)
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Coordination notes

- Pairs with **AISDLC-106** (GH Actions auto-trigger workflow) and **AISDLC-107** (Slack escalation-only notification). 105 ships the action; 106 wires the trigger; 107 surfaces the human escalation path.
- Future invocations of `/ai-sdlc rebase <pr>` complement `/ai-sdlc execute` (which uses Step 10.5 from AISDLC-102 for pre-sign rebase). Both rely on the shared `--print-content-hash` oracle for the no-op case.

## Follow-up (deferred, all non-blocking)

- **Code minor (pre-existing)**: Step 1 sed regex returns input unchanged when branch doesn't match `ai-sdlc/<prefix>-<digits>` shape. Add defensive guard `echo "$TASK_ID_LOWER" | grep -qE '^[a-z]+-[0-9.]+$'` after the sed to fail crisply on unexpected branch shapes. Pre-existing, not regressed by round 2.
- **Test minor**: push-site count test only checks `commands/rebase.md`. Consider parallel assertion in `rebase-resolver.test.mjs` that the subagent's only push reference is inside a documentation fence.
- **Test suggestion**: BSD-portability test models the regex via JS rather than spawning real `sed`. Heavier-weight option: spawn `sed -E '<literal>'` in child_process on macOS runners. Current shape assertions (`[a-z]+-[0-9.]+` present, `+?` absent) are sufficient.
- **Test suggestion**: iteration-fidelity regex `/iterationCount.*?1|PRE_ITER/` is loose. Tighten to `/PRE_ITER=.*\.payload|PRE_ITER=\$\(jq/` to lock the read path.
- **Reconciliation**: subagent Rule 1 says "order doesn't matter" for CHANGELOG keep-both, but task spec says "earliest first". Reconcile in the subagent prompt or relax the spec.
<!-- SECTION:FINAL_SUMMARY:END -->
