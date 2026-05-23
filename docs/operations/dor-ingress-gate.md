# DoR Ingress Gate (AISDLC-379)

The DoR ingress workflow (`.github/workflows/dor-ingress.yml`) is a hard
merge gate: a PR that adds or modifies a `backlog/tasks/*.md` file is
blocked when any of those tasks fails the Definition-of-Ready rubric and
does not carry an explicit operator-override.

## Behavior summary

For every PR opened / re-opened / synchronized that touches
`backlog/tasks/*.md`:

1. **Detect changed task files** — 3-dot diff against the PR base (AISDLC-197);
   moves on `main` from sibling merges are filtered out so a moved task
   doesn't enter the evaluation set spuriously.
2. **Evaluate each task** — `pipeline-cli dor-evaluate ... --hermetic`
   scores the task body against the seven-point rubric.
3. **Post the comment** — `<!-- ai-sdlc:dor-comment channel="author" -->`
   is created (or updated) on the PR listing per-task verdicts.
4. **Compute `has_violations`** — `pipeline-cli dor-pr-has-violations`
   consumes the per-task verdict JSONL and applies the operator-override
   rule (`blocked.reason` in frontmatter). Output is the
   `has_violations` step output.
5. **Fail the check** — when `has_violations == 'true'` the workflow exits
   `1`. The `Evaluate backlog tasks changed by PR` status check turns
   red, the PR's required-checks rollup goes UNSTABLE, and auto-merge
   cannot proceed.

Pre-AISDLC-379, step 5 did not exist: the check always returned SUCCESS
regardless of how many violations were posted. The 2026-05-20 RFC-0041
task-breakdown PR (the AISDLC-377 phase files) shipped with Gate-3
unresolved-reference violations on every task and the merge state was
CLEAN — auto-merge armed against the violations.

## Operator override — `blocked.reason`

Tasks that carry a `blocked.reason` entry in their YAML frontmatter
bypass the gate. The operator has explicitly acknowledged the violation
and accepted the merge despite it (typically because the offending
reference will be resolved by the same PR's `main` merge).

```yaml
---
id: AISDLC-NNN
title: '...'
status: To Do
blocked:
  reason: 'RFC-0024 OQs acknowledged; operator walkthrough scheduled for 2026-05-20'
---
```

The override is the SAME mechanic the
[upstream-OQ gate (AISDLC-296)](../../spec/rfcs/RFC-0011-definition-of-ready-rubric.md)
already supports — a task whose `blocked.reason` is set skips both the
upstream-OQ gate (when called from `refineBacklogTask()` /
`/ai-sdlc execute`) AND the DoR ingress workflow gate.

Both single-line forms are recognised by `extractBlockedReason()` in
`pipeline-cli/src/dor/upstream-oq-gate.ts`:

```yaml
# Two-line form (preferred):
blocked:
  reason: 'text'

# Inline-braces form (rare but supported):
blocked: { reason: 'text' }
```

Use the override only when the violation is genuinely transient or
acknowledged. **Do not use it as a routine merge bypass.** The
calibration log captures every override so a recurring pattern surfaces
in `cli-dor-stats` digests.

## Branch protection

`Evaluate backlog tasks changed by PR` must be listed in the
required-status-checks for `main`. The canonical list is encoded in
`scripts/sync-dor-branch-protection.sh`:

```bash
scripts/sync-dor-branch-protection.sh                  # apply the canonical list
scripts/sync-dor-branch-protection.sh --dry-run        # print the gh api call
scripts/sync-dor-branch-protection.sh --repo owner/repo
```

Re-running the script is idempotent — it PATCHes the full required-
contexts list. To add or remove a context, edit the `REQUIRED_CONTEXTS`
array at the top of the script and re-run.

## Hermetic tests

| File | Coverage |
|---|---|
| `pipeline-cli/src/dor/pr-violations.test.ts` | Unit tests for `computePrViolations()` — clean / override / blocking / mixed-batch / missing-file / absolute-path / empty-input branches. |
| `pipeline-cli/src/cli/index.test.ts` (`dor-pr-has-violations` block) | CLI envelope shape + `--fail-on-violations` exit behavior. |
| `.github/workflows/__tests__/dor-ingress.test.mjs` | Workflow YAML structure — `Compute has_violations` step wiring, `Fail check on unresolved violations` step `exit 1` + `::error::` annotation, step order (comment-post BEFORE fail), CLI invocation via direct node bin path (CLAUDE.md CI rule). |

Run locally:

```bash
pnpm --filter @ai-sdlc/pipeline-cli test -- pr-violations
node --test .github/workflows/__tests__/dor-ingress.test.mjs
```

## Recovery — my PR is red

The PR comment lists every blocking task and the offending gate. Two
ways forward:

1. **Fix the task body.** Edit the file in the PR, push, the workflow
   re-runs, the comment updates, the check turns green.
2. **Acknowledge with an override.** Add a `blocked.reason` block to the
   task's frontmatter (see above), push, the check turns green.

The PR will NOT auto-merge until the check is green either way — that
is the whole point of the gate. Bypassing via
`AI_SDLC_BYPASS_ALL_GATES=1 git push` is permitted only for emergency
ship windows; document every use in the PR body
(see `docs/operations/emergency-bypass.md`).
