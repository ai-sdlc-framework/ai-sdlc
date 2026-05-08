---
id: AISDLC-228
title: >-
  Step 3 self-heal quarantines active worktree mid-flight without checking for
  unpushed commits or open PR
status: To Do
assignee: []
created_date: '2026-05-07 02:50'
labels:
  - bug
  - orchestrator
  - rfc-0015
  - framework-bug
  - dogfood
  - p0
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`cli-orchestrator tick`'s Step 3 self-heal (AISDLC-224 — auto-cleanup stale worktree branches) renamed an actively-in-use worktree branch to a `quarantine/<task-id>-<timestamp>` ref while the operator was mid-pipeline (signing attestation + pushing). The worktree directory was deleted out from under an open shell. The dev's commit (`8f20a42`) and the operator's just-signed attestation chore commit (`003496f`) survived only because git's reflog kept the quarantine ref alive — otherwise the work would have been lost entirely.

## Witnessed sequence (2026-05-07)

1. Operator running orchestrator-driven dispatch of AISDLC-178.4.1 (Tier 2 task, 8 ACs)
2. Background `cli-orchestrator tick` process completed dev subagent ~20min mark; commit `8f20a42` landed in `.worktrees/aisdlc-178.4.1/`
3. Operator (in main session) spawned 3 reviewers in parallel against the worktree, all approved with minor/suggestion only
4. Operator wrote 3 verdict files, signed DSSE attestation, committed as chore commit `003496f`, ran `git push -u origin ai-sdlc/aisdlc-178.4.1-...`
5. Push errored out: `husky - pre-push script failed (code 1)` — root cause unclear (transient hook race?)
6. Concurrently: background orchestrator tick fired Step 3 self-heal, saw the branch existed, RENAMED it to `quarantine/aisdlc-178.4.1-2026-05-07T02-37-40-838`, and `git worktree remove --force`'d the directory
7. Operator's `cd` into the worktree path failed with `no such file or directory`
8. Recovery: `git worktree add .worktrees/aisdlc-178.4.1 -b ai-sdlc/aisdlc-178.4.1-... quarantine/aisdlc-178.4.1-2026-05-07T02-37-40-838` (rebuilt from quarantine ref) → re-push succeeded → PR #386 opened

## Root cause hypothesis

Step 3 (AISDLC-224) is "stale worktree branch cleanup" — designed to recover from operator-state issues. But its predicate is too aggressive: it treats ANY existing branch with the dispatch-target name as "stale" and quarantines it, without checking:

- Are there commits on the branch that don't exist on origin? (unpushed work)
- Is there a worktree directory with a `.active-task` sentinel? (active dispatch in another session)
- Is there a `claude --print` subprocess running with this task ID in its argv? (live dev subagent)
- Is there an open PR for this branch? (in-flight review)

Any of those signals = NOT stale, do not quarantine. The current implementation only checks "does the branch exist?" → if yes, quarantine.

## Proposed design

### Tighter predicate: `isReallyStale(branch)`

```typescript
async function isReallyStale(branch: string, ctx: FilterContext): Promise<{stale: boolean, reason?: string}> {
  // (1) Unpushed commits → not stale
  const ahead = await ctx.git.commitsAhead(branch, "origin/main");
  if (ahead > 0) {
    const upstream = await ctx.git.upstreamOf(branch);
    if (!upstream) return { stale: false, reason: `${ahead} unpushed commits, no upstream` };
    const aheadOfUpstream = await ctx.git.commitsAhead(branch, upstream);
    if (aheadOfUpstream > 0) return { stale: false, reason: `${aheadOfUpstream} commits ahead of ${upstream}` };
  }

  // (2) Active worktree with sentinel → not stale
  const wtPath = path.join(ctx.repoRoot, ".worktrees", taskIdLower);
  if (await fileExists(path.join(wtPath, ".active-task"))) {
    const mtime = await fs.stat(path.join(wtPath, ".active-task")).then(s => s.mtimeMs);
    const ageMs = Date.now() - mtime;
    if (ageMs < 6 * 60 * 60 * 1000) return { stale: false, reason: `active sentinel modified ${Math.round(ageMs/60000)}min ago` };
  }

  // (3) Live claude -p subprocess for this task → not stale
  if (await ctx.processProbe.findClaudePForTask(taskId)) {
    return { stale: false, reason: `live claude -p subprocess for ${taskId}` };
  }

  // (4) Open PR for this branch → not stale
  const openPRs = await ctx.gh.listOpenPRs({ headRef: branch });
  if (openPRs.length > 0) {
    return { stale: false, reason: `PR #${openPRs[0].number} open` };
  }

  return { stale: true };
}
```

### Quarantine still allowed when truly stale

The quarantine pattern itself is good — it's nondestructive (rename, not delete). The fix is just gating it behind a stricter predicate.

### Confirmation logging

When Step 3 chooses NOT to quarantine because of a "not stale" signal, emit a TICK trace line:

```
[step-3] aisdlc-178.4.1: keeping branch (active sentinel modified 12min ago)
```

So the operator running `cli-orchestrator tick` can see why a branch was preserved.

## Acceptance Criteria

- [ ] #1 `isReallyStale(branch)` predicate added to `pipeline-cli/src/orchestrator/steps/03-step3-self-heal.ts` (or wherever AISDLC-224 landed) with all 4 signal checks (unpushed commits, active sentinel < 6h, live claude -p subprocess, open PR)
- [ ] #2 Step 3 only quarantines when ALL 4 checks return stale
- [ ] #3 When NOT quarantining, Step 3 emits a TICK trace line naming the preserving signal
- [ ] #4 Hermetic test fixtures cover all 4 "not stale" branches plus the "all stale → quarantine" path
- [ ] #5 Documents the predicate in `docs/operations/orchestrator-runbook.md` under "Worktree quarantine rules"
- [ ] #6 Recovery playbook documented: if quarantine DID fire on active work, how to recover commits from the `quarantine/<id>-<ts>` ref via `git worktree add ... quarantine/...`
- [ ] #7 No regression: AISDLC-224's truly-stale-branch cleanup still fires when a branch has no unpushed commits, no sentinel, no subprocess, no open PR

## Composes with / supersedes

- Closes a regression introduced by **AISDLC-224** (the original Step 3 self-heal that's too aggressive)
- Composes with **AISDLC-227** (in-flight detection filter) — both are in-tick admission/cleanup hardening; should ship together as the Step 0/3 hardening pair
- Composes with **AISDLC-226** (stale-dist auto-rebuild) — same self-reliance philosophy: orchestrator should make smart self-heal decisions, not destroy operator state to "make tick proceed"

## References

- `pipeline-cli/src/orchestrator/steps/03-step3-self-heal.ts` (where the fix lands; path approximate — wherever AISDLC-224 implemented Step 3)
- AISDLC-224 (the introducing PR — its overzealous predicate is what this fixes)
- AISDLC-227 (sister bug — same root cause class: "orchestrator doesn't check what work is in flight before acting")
- Witnessed dogfood incident 2026-05-07: AISDLC-178.4.1's worktree quarantined mid-attestation-sign; PR #386 was rescued via reflog recovery
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 `isReallyStale(branch)` predicate added with all 4 signal checks
- [ ] #2 Step 3 only quarantines when ALL 4 checks return stale
- [ ] #3 When NOT quarantining, Step 3 emits a TICK trace line naming the preserving signal
- [ ] #4 Hermetic test fixtures cover all 4 "not stale" paths + "all stale → quarantine" path
- [ ] #5 Documents the predicate in `docs/operations/orchestrator-runbook.md`
- [ ] #6 Recovery playbook documented for the case where quarantine fired on active work
- [ ] #7 No regression: AISDLC-224's truly-stale-branch cleanup still fires for branches with no in-flight signals
<!-- SECTION:ACCEPTANCE:END -->
