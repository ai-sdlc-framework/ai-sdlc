---
id: AISDLC-370
title: 'feat(hooks): pre-push DoR gate — shift DoR clarifications left before CI'
status: Done
assignee: []
created_date: '2026-05-19'
labels:
  - hooks
  - dor
  - throughput
  - critical
dependencies: []
priority: critical
references:
  - pipeline-cli/src/dor/upstream-oq-gate.ts
  - .husky/pre-push
---

## Problem

Operator session 2026-05-19: DoR clarifications currently surface only as PR comments after a full CI cycle. Pattern:

1. Agent edits a backlog task body
2. Agent pushes
3. CI runs (~5-8min with the AISDLC-368 throughput patch live)
4. DoR ingress comments on the PR with violations
5. Agent reads, fixes, re-pushes
6. Another CI cycle (~5-8min)
7. Repeat until clean

For this session a single docs-only PR round-tripped 3+ times (amend + repush each cycle) before DoR went clean. Each round costs 5-8min of CI wall-clock waiting.

**Fix**: catch DoR violations in the pre-push hook so the agent fixes them locally before the push ever lands. Same engine, earlier invocation.

## Design

### A. New CLI: `cli-dor-check`

A new thin wrapper bin under `pipeline-cli/bin/` that calls into the existing engine at `pipeline-cli/src/dor/upstream-oq-gate.ts` + the seven-point rubric in `refineBacklogTask()`.

Usage (illustrative):

```bash
# Check one task file
node pipeline-cli/bin/<cli-name> --task backlog/tasks/<task-id>.md

# Check all staged task files in a push range
node pipeline-cli/bin/<cli-name> --staged
```

Exits non-zero on any unresolved-marker / unresolved-reference / unresolved-dependency-phrase finding. Prints findings in the same format as the CI workflow comment so the operator sees identical wording.

### B. Pre-push hook integration

Append a new step to `.husky/pre-push` (after coverage, task-move, attestation-sign):

```bash
# AISDLC-370: DoR shift-left. Catch task-body violations before CI.
if [ -z "${AI_SDLC_SKIP_DOR_GATE:-}" ]; then
  echo "[dor-gate] checking staged backlog task changes..."
  node pipeline-cli/bin/<cli-name> --staged --push-range "$1..$2" || {
    echo ""
    echo "[dor-gate] DoR violations in staged tasks. Fix the body and re-push."
    echo "[dor-gate] Defer with: AI_SDLC_SKIP_DOR_GATE=1 git push"
    exit 1
  }
fi
```

Reads `git rev-list <range>` to find which `backlog/tasks/*.md` and `backlog/completed/*.md` files were touched, runs the check on each.

### C. Test wiring + hermetic test

- A new hermetic-test file under `scripts/` (parallel to existing `check-*.test.mjs` hook tests) — feed fixture task files with known DoR violations + assert the gate exits non-zero with the right message
- Wire into a `pnpm test:dor-gate` script alongside other hook tests

### D. Docs

Add a short section to `CLAUDE.md`'s "Hooks" list documenting the new gate, the skip flag, and the typical fix loop.

## Acceptance criteria

- [ ] A new bin under `pipeline-cli/bin/` exists, callable from a fresh worktree, calls into existing `pipeline-cli/src/dor/upstream-oq-gate.ts` engine
- [ ] `--task <path>` mode checks a single task file
- [ ] `--staged --push-range A..B` mode walks the push range, finds touched task files, checks each
- [ ] Exit non-zero on any finding; prints comment-identical format
- [ ] Pre-push hook integration via `.husky/pre-push` with `AI_SDLC_SKIP_DOR_GATE=1` opt-out
- [ ] Hermetic test under `scripts/` covering: clean task, gate-2 marker, gate-3 unresolved reference, gate-7 dependency phrase
- [ ] Test wired into a `pnpm test:dor-gate` script and run by the workspace's `pnpm test`
- [ ] Run the gate against the AISDLC-370 task body itself — it must pass on the PR's own task file

## Out of scope

- pre-commit DoR check (adds latency to every commit; pre-push catches the same cases with one batched run per push)
- DoR check on staging area before commit (operator-level UX; CLI is sufficient)
- Auto-fix mode for common DoR violations (separate AISDLC follow-up — needs LLM round-trip for rewording)

## Source

Operator question 2026-05-19: "Should we be running DoR checks on commit or on push hooks so the agent can fix them before they get to the PR?" — answered: pre-push is the right tier; this task is the implementation.
