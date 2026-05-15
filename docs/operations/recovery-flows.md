# Pipeline Recovery Flows

> AISDLC-273 — added draft-PR resume, PR rework, and crash recovery surface.

This document describes all recovery paths for a stalled or crashed pipeline dispatch.

## Decision tree

```
Is there a worktree for the task?
│
├─ NO → Nothing to recover. Run normally:
│        ai-sdlc-pipeline execute <task-id> --run --spawner api-key
│
└─ YES → Is there an open PR for the branch?
         │
         ├─ NO (worktree + sentinel + commits, no PR)
         │   → Crash BEFORE Step 11 (push).
         │   → Path A: Recoverable-abort resume (AISDLC-242).
         │   → Run: ai-sdlc-pipeline execute <task-id> --run --spawner api-key
         │          (executePipeline detects the worktree and will re-use it)
         │
         ├─ YES, DRAFT PR (Step 11 completed, Steps 12-13 incomplete)
         │   → Path B: Resume from draft PR (AISDLC-273).
         │   → Run: ai-sdlc-pipeline execute <task-id> --resume-from-draft --spawner api-key
         │
         └─ YES, READY PR (Steps 11-13 completed; reviewers flagged issues post-merge)
             → Path C: Rework PR (AISDLC-273).
             → Run: ai-sdlc-pipeline execute <task-id> --rework-pr <pr-number> --spawner api-key
```

---

## Path A — Crash recovery (recoverable abort, AISDLC-242)

**When:** The previous dispatch was killed (SIGTERM, SIGKILL, watchdog, network blip) BEFORE Step 11 (push + open draft PR). The worktree exists with commits on the branch but no open PR.

**Signals:**
- `.worktrees/<task-id>/` exists on disk
- `.worktrees/<task-id>/.active-task` sentinel contains the task ID
- `git rev-list --count origin/main..HEAD` > 0
- No open PR (draft or ready) on GitHub

**Recovery:**

```bash
ai-sdlc-pipeline execute <task-id> --run --spawner api-key
```

The `executePipeline()` function detects the recoverable state via `detectRecoverableWorktree()` and surfaces it in the `recoverableAbort` field of the return envelope. The CLI emits a progress line:

```
[ai-sdlc-progress] execute: recoverable-abort detected: 3 commit(s) (1 checkpoint(s)) on branch; re-run with --resume-from-draft AISDLC-NNN to continue
```

**Note:** As of AISDLC-273, `executePipeline()` in the umbrella path also surfaces the `recoverableAbort` field so operators can see what was preserved. The autonomous orchestrator loop (`runOrchestratorTick`) already handled this on the next tick; this is the new umbrella path surface.

---

## Path B — Resume from draft PR (AISDLC-273)

**When:** The dispatch completed Steps 5-11 (dev work done, draft PR open) but was interrupted before Step 12 (reviewers) or Step 13 (ready promotion).

**Why the pipeline can't just re-run:** Step 3's safety predicate detects the open PR and refuses to create a new worktree. Until AISDLC-273, this was a hard block for draft PRs and ready PRs alike.

**Signals (all must be true):**
- A draft PR is open for the branch (`isDraft: true` from `gh pr list`)
- The branch has commits beyond `origin/main`

**Resume sub-cases (auto-detected):**

| Sub-case | Condition | Steps resumed |
|---|---|---|
| A — Ready flip only | Attestation chore commit present | Step 13 (`gh pr ready`) only |
| B — Push + ready | Verdict file exists, no attestation commit | Force-push (triggers attestation hook) → Step 13 |
| C — Reviewers + ready | No verdict file | Steps 7/8 (reviewers) → Step 10 (verdict file) → push → Step 13 |

**Recovery command:**

```bash
ai-sdlc-pipeline execute <task-id> \
  --resume-from-draft \
  --spawner api-key
```

**Output shape:**

```json
{
  "ok": true,
  "resumeFromDraft": {
    "resumedFrom": "Step 13 (attestation already present)",
    "prUrl": "https://github.com/owner/repo/pull/42",
    "outcome": "resumed-and-ready"
  }
}
```

**Constraints:**
- Does NOT re-dispatch the developer. The existing commits are the unit of work.
- Requires a real spawner (`--spawner api-key` or `--spawner claude-cli`) even for the reviewer-only sub-cases (the spawner is used to re-run reviewers in sub-case C).
- `--spawner mock` is refused.

---

## Path C — PR rework (AISDLC-273)

**When:** Reviewers (automated or post-hoc) found critical/major issues AFTER the PR was opened (draft or ready). The operator wants to re-dispatch the developer to fix the findings on top of the existing branch.

**Signals:**
- A PR exists (draft or ready) for the branch
- PR comments contain the `<!-- ai-sdlc:reviewer-findings -->` marker (written by the automated review step)

**Recovery command:**

```bash
ai-sdlc-pipeline execute <task-id> \
  --rework-pr <pr-number> \
  --spawner api-key
```

**What it does:**

1. Fetches PR metadata (branch name → derives task ID).
2. Reads PR comments with `<!-- ai-sdlc:reviewer-findings -->` marker.
3. Builds a developer prompt with the original task context PLUS the reviewer findings as additional context ("fix these specific issues").
4. Dispatches the developer subagent to rework the branch.
5. Re-runs all 3 reviewers.
6. Iterates up to `--max-iterations` rounds if reviewers still find issues.
7. Finalizes (writes summary + AC check + attestation).
8. Force-pushes (`--force-with-lease`) the rebased + re-attested HEAD.
9. Flips the PR to ready (if it was draft).

**Rework iteration cap:**

The `--rework-pr` path uses the same `--max-iterations` cap as the normal execute path (default 2). After the cap is hit with unresolved findings, the PR is tagged `[needs-human-attention]` and the command exits with `outcome: 'needs-human-attention'`. Invoke with a higher `--max-iterations` to allow more rework rounds.

**Output shape:**

```json
{
  "ok": true,
  "reworkPr": {
    "prUrl": "https://github.com/owner/repo/pull/42",
    "outcome": "approved",
    "iterations": 2,
    "finalVerdict": {
      "decision": "APPROVED",
      "approved": true,
      "counts": { "critical": 0, "major": 0, "minor": 0, "suggestion": 1 }
    }
  }
}
```

---

## Step 9 iteration loop (within a single session)

This is not a cross-session recovery — it is the NORMAL flow within a single `executePipeline()` invocation. When reviewers return CHANGES_REQUESTED, `iterateReviewLoop()` re-dispatches the developer and re-runs all 3 reviewers. The iteration cap (default 2) limits the number of rounds before the PR is flagged `[needs-human-attention]`.

**This path is always active and requires no operator action.** It is documented here for completeness.

---

## Observability signals

### Progress lines

```
[ai-sdlc-progress] resume-from-draft: detecting state for AISDLC-NNN
[ai-sdlc-progress] resume-from-draft: Step 13 only: flipping draft PR #42 to ready
[ai-sdlc-progress] resume-from-draft: PR #42 flipped to ready

[ai-sdlc-progress] rework-pr: fetching PR #42 metadata
[ai-sdlc-progress] rework-pr: running 3 reviewers after rework
[ai-sdlc-progress] rework-pr: outcome=approved iterations=1 verdict=APPROVED

[ai-sdlc-progress] execute: recoverable-abort detected: 3 commit(s) on branch; re-run with --resume-from-draft AISDLC-NNN to continue
```

### Step 3 trace lines (auto-cleanup predicate)

```
[step-3] aisdlc-nnn: keeping branch (draft PR found for ai-sdlc/aisdlc-nnn-...)
[step-3] aisdlc-nnn: keeping branch (ready PR found for ai-sdlc/aisdlc-nnn-...)
```

The `draft PR` vs `ready PR` distinction in the trace is the AISDLC-273 Step 3 predicate improvement. Both still block auto-cleanup — the distinction is for operator visibility only (draft → offer `--resume-from-draft`; ready → offer `--rework-pr`).

---

## Flag reference

| Flag | Requires | Description |
|---|---|---|
| `--run` | real spawner | Normal full Step 0-13 dispatch |
| `--resume-from-draft` | real spawner | Resume stalled draft-PR dispatch (AISDLC-273) |
| `--rework-pr <n>` | real spawner | Rework existing PR branch with reviewer findings (AISDLC-273) |
| `--dry-run` | — | Validate + compute plan, no mutation |
| `--spawner mock` | — | Dry-run/plumbing fixture; refused for `--run`/`--resume-from-draft`/`--rework-pr` |
| `--spawner api-key` | `ANTHROPIC_API_KEY` env | Real API-key billed dispatch |
| `--spawner claude-cli` | slash command body | Inline manifest mode (AISDLC-198) |
| `--max-iterations N` | — | Cap for Step 9 + rework loops (default 2) |
