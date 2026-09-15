---
id: AISDLC-616
title: Persist first-pass reviewer findings to an append-only ledger (measure reviewer marginal value)
status: Done
priority: high
labels:
  - observability
  - reviewers
  - attestation
  - cost
dependencies: []
created: 2026-09-14
---

## Context

An operator investigation (2026-09-14) tried to answer an empirical, cost-driven
question: **does running 3 reviewers (code + test + security) catch materially
more blocking defects than 1 reviewer would** — because 3 reviewers cost ~3x the
tokens, and if one combined reviewer could do the job we could cut that.

The investigation found the question **cannot currently be answered from retained
data**, and that finding is the whole reason for this task:

- **Verdict files are gitignored** (`.ai-sdlc/verdicts/*.json`) — 0 commits in
  history. Each review iteration overwrites the previous, so first-pass findings
  are gone.
- **Transcripts retain only the final verdict** (`.ai-sdlc/transcripts/<task>/<role>.jsonl`
  are ~2-line files: prompt-received + final assistant verdict). By merge time
  every reviewer has flipped to APPROVED (you don't merge until findings are
  fixed), so the retained end-state is **all-approved by construction** — code
  0/138, test 0/25, security 3/73 "blocking" across both dogfood repos.
- **subagent-sessions** carry only dispatch metadata (`agentId`, `agentType`,
  `firedAt`) — no findings.

Net: the exact signal needed to justify (or retire) the 3rd/2nd reviewer — *how
often reviewer N+1 raises a blocking finding that reviewer N missed* — is
destroyed on every run. Deciding to drop from 3→1 (or 3→2, see AISDLC-617) off
this data would be flying blind on the one metric that matters.

A second, compounding data-loss bug surfaced: **transcript-routing scatter** —
reviewer transcripts route to the most-recently-modified `.active-task` sentinel
across worktrees, so with concurrent worktrees the same-named `code-reviewer.jsonl`
scatters/clobbers. This is why local-trades shows 103 "code-only" transcript dirs
even though the dispatch census (code 63 / security 45 / test 38 per 38 developer
dispatches) proves all three actually ran. Fix it here so the ledger is complete.

## Scope

- Add an **append-only reviews ledger** written at each reviewer verdict (first
  pass AND every iteration), one JSONL record per reviewer per iteration, e.g.
  `.ai-sdlc/reviews/<task-id>.jsonl`, NOT overwritten. Each record:
  - `taskId`, `prNumber` (if known), `commitSha`, `iteration`, `role`
    (`code`/`test`/`security`), `harness`, `timestamp`
  - `verdict` (`approved` | `rejected`), `findings`:
    `[{severity: critical|major|minor|suggestion, summary, ...}]`
  - enough to later dedupe cross-reviewer (a short normalized `title`/`area` so
    two reviewers flagging the same defect can be matched).
- Ensure it is **committed / retained** (not gitignored like the verdict files),
  or exported to a durable location — the whole point is that history survives.
  If retention must stay out of the repo, write to an operator-durable path and
  document it. Confirm the path is NOT under an attestation-verified diff (backlog
  paths-ignore precedent) OR is explicitly excluded, so it never perturbs the
  Merkle/patch-id (coordinate with AISDLC-610 PATCH_ID_EXCLUSIONS).
- **Fix the transcript-routing scatter**: route each reviewer's transcript by the
  dispatching worktree's own sentinel/task id, not the most-recently-modified
  global `.active-task`, so concurrent worktrees don't clobber. (Same root cause
  noted in the AISDLC-609/610/611 reconciles.)
- Add a tiny **analysis command / script** that reads the ledger across repos and
  reports, per role: block rate, sole-blocker rate (role raised a blocking
  finding no other role did on the same commit), cross-reviewer finding overlap,
  and a McNemar-style discordant-pair count (single-reviewer decision vs panel
  decision). This is the tool that will actually answer the 3-vs-1 question after
  a few weeks of data.

## Acceptance Criteria

- [ ] AC-1: Every reviewer verdict (each iteration, including the first) appends a
      record to a durable, non-overwritten ledger; a task run through the pipeline
      leaves ≥1 record per dispatched reviewer per iteration.
- [ ] AC-2: Records carry role, severity-tagged findings, verdict, commitSha,
      iteration, and a normalized finding title/area sufficient for cross-reviewer
      dedupe.
- [ ] AC-3: Transcript-routing scatter fixed — concurrent worktrees each persist
      their own reviewer transcripts without clobbering; a hermetic test simulates
      two active sentinels and asserts no cross-routing.
- [ ] AC-4: Ledger retention is durable (survives the "verdicts are gitignored"
      trap) and provably does NOT perturb attestation patch-id / Merkle root
      (exclusion test, in lockstep with AISDLC-610).
- [ ] AC-5: Analysis command reports per-role block rate, sole-blocker rate,
      cross-reviewer overlap, and discordant-pair (panel-vs-single) count over the
      ledger; hermetic fixture test proves the math.
- [ ] AC-6: `pnpm build && test && lint` clean; docs note in the attestation /
      observability runbook explaining how to read the ledger and run the analysis.

## References

Operator reviewer-cost investigation (2026-09-14). Blocks the data-driven part of
AISDLC-617 (code+test reviewer merge) — that decision should be validated against
this ledger before permanent rollout. Related: AISDLC-610 (patch-id exclusions),
the transcript-routing scatter observed in the AISDLC-609/610/611 reconciles,
subscription cost concerns (per-role model split, PR #327).
