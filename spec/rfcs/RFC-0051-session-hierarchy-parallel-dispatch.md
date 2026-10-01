---
id: RFC-0051
title: Session Hierarchy for Parallel Dispatch (planner, operator-dispatch, executors)
status: Approved
lifecycle: Signed Off
author: 'Dominique Legault'
created: 2026-09-30
updated: 2026-09-30
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0012, RFC-0035, RFC-0041, RFC-0048, RFC-0049, RFC-0050]
requiresDocs:
  - operator-runbook
deferredDocs: true
deferredDocsDeadline: '2026-11-30'
---

# RFC-0051: Session Hierarchy for Parallel Dispatch (planner, operator-dispatch, executors)

**Status:** Signed Off (2026-09-30, Engineering + Operator) — **all 3 Open Questions
resolved via operator rubric walkthrough.** Resolutions: **(OQ-1)** assignments travel
by board pull: `operator-dispatch` writes ordered manifests to the RFC-0041 Dispatch
Board and executors claim them atomically; messages carry status and questions only;
**(OQ-2)** operational authority is granted in policy, not typed per session:
`allowForcePush: leaseOnOwnBranch` in `spec.governance` plus an `operational` list for
the dispatch role; `main` stays permanently fixed; **(OQ-3)** `operator-dispatch` and
the executors run `bypassPermissions` with the governance hook active and inbound
messages accepted; the planner runs in the operator's normal mode, so messages to it
are held for the operator, which is the human gate. Phase tasks AISDLC-663 to
AISDLC-671.

## Summary

Codifies the three-tier arrangement the operator arrived at after trying several
parallel-execution shapes: one **planner** session (Fable) where backlog work is
designed; one **operator-dispatch** session (Opus or Sonnet) that owns throughput; and
N **executor** sessions (Sonnet, five by default) that each run exactly one
`/ai-sdlc execute` at a time. The tiers are peer Claude Code sessions technically; the
hierarchy is a protocol: fixed names, a role per session, an authority matrix, a durable
assignment channel, an escalation chain that runs upward and ends at the operator only
as a last resort, and a context-lifecycle rule that empties an executor between tasks.
A bootstrap command starts the whole arrangement in tmux and writes a roster the tiers
use to find each other.

## Motivation

### Why sessions, not subagents

A Claude Code session can dispatch subagents one level deep. `/ai-sdlc execute` is a
slash command that itself dispatches the developer and reviewer subagents, so it must
run at the top level of a session. A session that tries to run several `execute`s in
parallel as subagents has to re-implement the pipeline by hand and loses the Step 0-13
guarantees (RFC-0012). RFC-0041 worked around the limit by splitting the pipeline:
Workers ran only the developer agent and a Conductor ran review fan-out. The operator
found that keeping `execute` whole and giving each run its own session works better.
That is this RFC's shape, and RFC-0041 §9.3 named it as an alternative.

### What the first parallel run showed (2026-09-30, RFC-0049/0050 dispatch)

Five executors ran the first wave. The run surfaced, in one afternoon:

- An executor could not rebase a conflicting PR because its governance resolved to
  "never force-push" and the operator's confirmation, typed in the dispatch session,
  could not reach it. A peer message is not a permission grant, by design. The
  operator would have had to re-confirm in every executor session, per PR, per push.
- Three wave-1 tasks each added an export to the same barrel file; the second and
  third to land conflicted and could not be rebased for the reason above.
- A gate fix merged on `main` did not reach open PRs, because reruns reuse a frozen
  merge ref. Executors spent several rounds before finding that an empty commit
  forces a fresh ref.
- Two executors filed follow-up tasks with the same id.
- A stale parent checkout made preflight report an unknown task and skip the sync
  step.
- Executors that finished a task kept its whole context for the next one. From the
  RFC-0050 measurement, cache reads are nearly all token volume, so a session carrying
  three finished tasks re-reads all of them on every turn of the fourth.

Each of these is a protocol gap, not an agent error. The executors did what their
sessions allowed.

### What already exists

- The RFC-0041 Dispatch Board: `queue/`, `inflight/`, `done/`, `failed/` manifests
  with atomic claim by rename, heartbeats and a stale-reaper
  (`pipeline-cli/src/dispatch/`).
- `execute-parallel` (AISDLC-462): spawns one tmux window per task running
  `/ai-sdlc execute`, with session files under `.ai-sdlc/dispatch/sessions/`.
- `cli-decisions escalate` (AISDLC-480): the async escape hatch for a dispatched
  session that cannot ask a question interactively.
- Cross-session messaging: named sessions (`claude --name`), `ListAgents`,
  `SendMessage`; messages between sessions in different permission classes are held
  for the user; `crossSessionInbound: "accept"` auto-accepts; a duplicate name is
  suffixed rather than refused.
- Per-repo governance with rule-specific value types (RFC-0048).

## Goals

1. One documented shape for parallel execution with named roles, started by one
   command.
2. Assignments that survive an executor crash, restart or context clear.
3. An escalation chain that resolves questions at the lowest tier able to answer
   them, and reaches the operator only through the decision rubric as a last resort.
4. Operational authority for the dispatch tier (rebase, lease-push on a task's own
   branch, retrigger CI, re-queue, file follow-ups) granted in policy so throughput
   never waits on a typed confirmation.
5. An executor's context emptied between tasks.
6. Per-role usage visible in the RFC-0050 ledger.

## Non-Goals

- Changing `/ai-sdlc execute` itself. Executors run it unmodified.
- Multi-machine hierarchies. The roster and board are filesystem-local, as RFC-0041
  OQ-5 decided.
- Replacing the autonomous orchestrator (RFC-0015) for the single-session case. This
  RFC covers the multi-session case.
- Running executors headless (`claude -p`). That draws the Agent SDK credit pool
  rather than subscription quota (RFC-0041 §4.1); executors stay interactive.
- Letting any tier resolve RFC Open Questions or change governance. Those remain the
  operator's, through the decision rubric.

## Proposal

### 1. Tiers, roles and authority

| Tier | Session name | Model | Owns | Must escalate |
| --- | --- | --- | --- | --- |
| planner | `planner` (or operator-chosen) | Fable | RFCs, task authoring, dispatch briefs, design answers | Operator decisions (OQs, policy), via the decision rubric |
| operator-dispatch | `operator-dispatch` | Opus or Sonnet | Sequencing, enqueueing, monitoring, unblocking, re-queueing, follow-up filing, context clears, answering operational questions | Design questions to planner; anything outside the operational list |
| executor | `executor-alpha` … `executor-epsilon` | Sonnet | One `/ai-sdlc execute` at a time, verdict reporting | Everything else, to operator-dispatch |

The **operational authority list** for `operator-dispatch` (and, where the pipeline
needs it, executors on their own task branch):

- `git rebase origin/main` and `git push --force-with-lease` on a task's own branch
  (never a protected branch);
- retrigger CI (empty commit, re-run), re-queue a failed manifest up to a configured
  retry count, re-sequence the queue;
- file follow-up tasks as sub-ids of the task that produced them (`AISDLC-629.1`),
  which cannot collide across PRs;
- answer a `Decision` whose scope is `operational` (sequencing, retries, which
  executor, whether to park);
- clear an executor's context between tasks.

Outside the list, and never delegated downward: resolving RFC Open Questions,
changing `.ai-sdlc/*` policy, editing a task's acceptance criteria, merging (unless
`allowMerge: onGreenClean` already permits it), anything on `main`.

### 2. Naming and the roster

The bootstrap writes `.ai-sdlc/dispatch/hierarchy.json`: for each session its role,
name, tmux window and pane, pid, model, permission mode and start time. Tiers resolve
"the dispatch session" or "an idle executor" from the roster, not from hard-coded
names, so the operator can rename or resize. Session names follow the roster; a
collision suffix added by the harness is written back to the roster at start.

The roster is also how the RFC-0050 ingester attributes a main session to a role: a
session whose name is in the roster is recorded under that role instead of
`main-session`.

### 3. Bootstrap: `cli-hierarchy`

```
cli-hierarchy up   [--executors 5] [--planner-model fable] [--dispatch-model opus]
                   [--executor-model sonnet] [--attach]
cli-hierarchy status
cli-hierarchy down [--role executor-gamma]
```

`up` creates (idempotently) the tmux session `ai-sdlc-hierarchy` with one window per
role and starts each session as
`claude --name <name> --model <model> --permission-mode <mode> "/ai-sdlc <role-skill>"`,
reusing the spawn, validation and resource gate from AISDLC-462. It writes the roster,
checks that `crossSessionInbound` is set as section 10 requires and prints what to
change if not, and refuses to start a second planner. `status` prints the roster with
each session's live state from the harness registry and the board's inflight view.
`down` ends sessions cleanly and re-queues their inflight manifests.

### 4. Assignment: the board (OQ-1)

`operator-dispatch` turns a brief into manifests on the RFC-0041 board. The manifest
gains three fields:

- `after`: task ids that must be in `done/` before this manifest is claimable;
- `sequenceGroup`: a label; at most one inflight manifest per group (the brief's
  "do not run side by side" rules become groups such as `schema-regen` and
  `root-barrel`);
- `priority` and `wave`: ordering hints.

Claim is atomic rename, as today. The claim logic skips a manifest whose `after` is
unmet or whose group is busy. A stale inflight (no heartbeat beyond the configured
limit, or its session gone from the roster) is returned to `queue/` by the reaper.
Messages never carry assignments.

### 5. The executor loop

`/ai-sdlc executor` runs in each executor session:

1. Claim the next eligible manifest, or wait and retry on an interval.
2. Run `/ai-sdlc execute <task-id>` unmodified.
3. Write the verdict to `done/` or a diagnostic to `failed/` (pipeline result, PR
   number, follow-up task ids, decision ids raised).
4. Send `operator-dispatch` a one-line status message.
5. Stop and wait for its context to be cleared (section 9). The loop resumes after the
   clear.

An executor never messages another executor, never answers a question for another
task, and never files a top-level task id: follow-ups it discovers are filed as
sub-ids of its own task.

### 6. The dispatch loop

`/ai-sdlc operator-dispatch` runs in the dispatch session on a wake-up interval:

- ingest new briefs from `.ai-sdlc/dispatch/briefs/` into manifests;
- watch `done/` and `failed/`: on a verdict, clear that executor's context (section 9)
  and apply the unblocking playbook on failures (rebase and lease-push, retrigger,
  re-queue within the retry limit, or escalate);
- route questions (section 8);
- report progress to the planner at a configured cadence and on completion of a brief.

The loop is mostly mechanical. The judgment calls it makes (is this failure
rebase-fixable, which sequence group does a new task belong to) are the kind
RFC-0049's judgment layer is built for and may move there later.

### 7. Planner hand-off

The planner produces a brief, the artifact the operator wrote by hand on 2026-09-30:
`cli-hierarchy brief --tasks <ids>` (or `--rfc RFC-NNNN`) writes
`.ai-sdlc/dispatch/briefs/<id>.md` with the waves derived from task `dependencies`,
sequence groups derived from overlapping `references`, trust-sensitive tasks, and the
operator-only tasks excluded. The planner edits it, then messages `operator-dispatch`
that it is ready. A brief is the unit of hand-off; the board is the unit of execution.

### 8. Escalation chain

A question goes to the lowest tier that can answer it, and every hop is recorded:

1. An executor that is blocked calls `cli-decisions escalate` with `--route
   operational` (sequencing, environment, retries) or `--route design` (RFC
   interpretation, scope, conflicting instructions), then messages
   `operator-dispatch` with the decision id, parks the task (manifest to `blocked/`
   with the decision id) and claims the next eligible manifest. Throughput does not
   wait on an answer.
2. `operator-dispatch` answers `operational` decisions itself within its authority and
   returns the manifest to `queue/`. It forwards `design` decisions to the planner by
   message, with the decision id.
3. The planner answers design decisions from the RFC and task text. A question the
   RFC does not settle is an Open Question in substance; the planner raises it to the
   operator with the decision rubric. That is the only point at which a human is
   asked, and it is deliberate.
4. Each hop has a timebox from config (defaults: operational 30 minutes, design
   4 hours). On expiry the decision moves up one tier automatically; silence never
   resolves a decision downward.

Answers are written to the Decision Catalog, so the executor that parked the task,
or any executor, can resume it with the answer in hand.

### 9. Context lifecycle

An executor's context is emptied after every task. The mechanism is `/clear` sent to
the executor's tmux pane by `operator-dispatch` when the verdict lands, followed by
the keystroke that restarts `/ai-sdlc executor`. `/clear` keeps the session's name
and permission mode and fires the `SessionStart` hook with matcher `clear`; the plugin's
hook re-injects the role from the roster so the fresh context knows what it is.
Headless relaunch is rejected because it changes the billing pool (Non-Goals).
Whether an executor can issue the clear to its own pane from inside its turn is
verified during implementation; the dispatch-driven path is the one the design
depends on.

### 10. Permissions and governance (OQ-2, OQ-3)

- `operator-dispatch` and executors start with `--permission-mode bypassPermissions`;
  the governance PreToolUse hook stays active in that mode, so the permanently fixed
  rules hold. Their settings carry `crossSessionInbound: "accept"`.
- The planner runs in the operator's normal mode. Messages from the lower tiers to it
  are held for the operator's approval, which is the human gate on the chain.
- `spec.governance.allowForcePush` becomes `never | leaseOnOwnBranch` (a boolean
  `true` is read as `leaseOnOwnBranch`). The hook permits `git push
  --force-with-lease` only when the target ref is the worktree's own task branch and
  is not `main`, `master` or any protected branch. This repository sets
  `leaseOnOwnBranch`.
- `spec.governance.operational` lists the actions in section 1 for the dispatch role,
  rendered into the dispatch session's injected rules like every other governance
  surface (RFC-0048).

### 11. Observability

Every claim, verdict, clear, escalation hop and unblocking action is an orchestrator
event. `cli-hierarchy status` shows the roster, the board, open decisions by tier and,
when RFC-0050's ledger is present, units per role for the current window. The
capabilities `hierarchy.board` and `hierarchy.clear` are registered under RFC-0049
section 9 so a broken clear or a stuck board shows as degraded in doctor.

## Design Details

### Schema Changes

- `spec/schemas/dispatch-manifest.v1.schema.json`: additive `after`, `sequenceGroup`,
  `priority`, `wave`, `blockedBy` (decision id).
- New: `spec/schemas/hierarchy-roster.v1.schema.json`.
- `spec/schemas/agent-role.schema.json`: `allowForcePush` accepts the enum (boolean
  retained); new `governance.operational` list.
- `spec/schemas/orchestrator-events.v1.schema.json`: additive `HierarchySessionStarted`,
  `ExecutorContextCleared`, `DecisionEscalated`, `DecisionRouted`.

### Behavioral Changes

None for a repo that never runs `cli-hierarchy up`. `execute-parallel` keeps working
and is marked superseded in its documentation. For this deployment shape the
Conductor's reviewer fan-out from RFC-0041 is not used; executors run the whole
pipeline. RFC-0041's board, worker kinds and supervisor remain for the headless shape.

### Migration Path

Additive. The first run follows the operator task AISDLC-671.

## Backward Compatibility

Not a breaking change. The governance enum accepts the existing boolean. Existing
manifests without the new fields are claimable as before.

## Alternatives Considered

### Alternative 1: One session, background subagents (RFC-0041 Pattern X)

The one-level limit forces the pipeline to be split and re-composed by the session,
which is the hand-rolled path the operator abandoned.

### Alternative 2: `execute-parallel` as is (fresh session per task)

No persistent executor identity, so no question can be routed back and every task
pays session start-up. It remains for one-off bursts.

### Alternative 3: Headless executors under the supervisor (`claude-p-shell`)

Correct shape, wrong billing pool after 2026-06-15, and no interactive surface for
the rare case where attaching helps.

### Alternative 4: Message push for assignments

Rejected in OQ-1: an assignment must outlive the executor.

### Alternative 5: Per-session or token-based grants for force-with-lease

Rejected in OQ-2: the action is routine on feature branches and belongs in policy.

## Implementation Plan

Nine phase tasks. AISDLC-663, 664 and 665 have no dependencies.

- **AISDLC-663 — governance scope for operational authority.** `allowForcePush`
  enum, own-branch enforcement in the hook, `governance.operational` list and its
  render; this repo's values (OQ-2).
- **AISDLC-664 — roster and `cli-hierarchy`.** Roster schema, `up`, `status`, `down`,
  permission-mode and `crossSessionInbound` preflight (OQ-3).
- **AISDLC-665 — board extensions.** `after`, `sequenceGroup`, `priority`, `wave`,
  `blockedBy`; claim logic; reaper changes; `cli-dispatch enqueue`.
- **AISDLC-666 — executor loop.** `/ai-sdlc executor` skill, verdict and status
  reporting, sub-id follow-ups, `SessionStart(clear)` role re-injection. Depends on
  664, 665.
- **AISDLC-667 — dispatch loop.** `/ai-sdlc operator-dispatch` skill: brief ingestion,
  verdict watch, context clears, unblocking playbook, progress reports. Depends on
  663, 664, 665.
- **AISDLC-668 — planner hand-off.** `cli-hierarchy brief`. Depends on 664.
- **AISDLC-669 — escalation chain.** `--route`, parking, timeboxes, auto-promotion,
  answer scoping by tier. Depends on 665, 667.
- **AISDLC-670 — docs.** Operator runbook; `execute-parallel` marked superseded.
  Depends on 666, 667.
- **AISDLC-671 — first supervised run.** Operator-only, non-dispatchable: run a brief
  through the hierarchy, measure per-role usage, record what stalled. Depends on
  666 to 669.

## Open Questions

**OQ-1 — How does an assignment reach an executor?** A message, a board manifest, or
a fresh spawned session per task?

**Resolution (2026-09-30, full rubric): board pull.** `operator-dispatch` writes
ordered manifests to the RFC-0041 Dispatch Board; executors claim the next eligible
one atomically, run `execute`, record a verdict and loop; messages carry status and
questions only. Industry research: the board protocol (atomic claim by rename, heartbeat,
stale reaper) already exists in `pipeline-cli/src/dispatch/` and was built for the
crash-and-resume cases a message cannot handle; AISDLC-462 spawns a window per task and
loses executor identity; cross-session messages are held across permission classes and
have no inbound hook, so they are a notification channel, not a queue. **Refinement:**
manifests gain `after` and `sequenceGroup` so the brief's file-overlap rules are
enforced by the claim logic, not remembered by an agent. **Counter-argument:** "The
board was designed for a Conductor that owns review fan-out; executors run the whole
pipeline, so half of RFC-0041 becomes dead code." Rebuttal: the protocol is the
reusable part; the Conductor's fan-out was the workaround for the one-level limit that
executors remove, and this RFC says so plainly in Behavioral Changes. **Selected over
message push** because an assignment must survive the executor, **and over spawn per
task** because executors need an identity questions can be routed to.

**OQ-2 — How do dispatch and executor sessions get operational authority?** A peer
message cannot grant permission, and the first run stalled on `--force-with-lease`.

**Resolution (2026-09-30, full rubric): scoped policy value.** `allowForcePush:
leaseOnOwnBranch` in `spec.governance`, plus a `governance.operational` list for the
dispatch role; the hook permits `--force-with-lease` only to a non-protected branch the
worktree owns; `main` and `master` stay under the permanently fixed rule. Industry
research: the repo's own git flow prescribes rebase plus lease-push on feature
branches and the `rebase-resolver` and `ci-conflict-resolver` agents already do it;
RFC-0048 gave governance rules per-repo value types and fixed the integrity rules;
`allowForcePush` was a boolean rendered as "NEVER force push" when unset; RFC-0043 reads
governance from the base branch only, so a PR cannot grant itself any of this.
**Counter-argument:** "Force-push is force-push; a policy allowing it is how a bad
rebase destroys a branch." Rebuttal: `--force-with-lease` refuses when the remote
moved, the target is the task's own worktree branch, protected branches stay fixed,
and the branch is a PR branch whose history GitHub keeps. **Selected over expiring
grants** because they add issue, store and verify machinery for a routine action,
**over per-session confirmation** because that is the stall being fixed, **and over
bypass without governance** because it removes the rules that matter.

**OQ-3 — Which permission modes do the tiers run in?** Messages are held across
permission classes; executors run unattended.

**Resolution (2026-09-30, full rubric): bypass below, normal at the top.**
`operator-dispatch` and executors run `bypassPermissions` with the governance hook
active and `crossSessionInbound: "accept"`; the planner runs in the operator's normal
mode, so messages to it are held for the operator, which is the human gate. Industry
research: the harness holds messages between the bypass class and the prompting class
and auto-accepts with the inbound setting; `execute-parallel` already runs spawned
windows with permissions skipped as an opt-in with the trade-off documented in
`docs/operations/parallel-dispatch.md`; governance hard rules are hook-enforced in every
mode. **Counter-argument:** "Bypass on five unattended sessions is the widest blast
radius in the system." Rebuttal: it is what the existing parallel path already does,
the hard rules hold in every mode, and the narrower option pays for its narrowness in
stalls, which this design exists to remove. **Selected over acceptEdits with an
allowlist** for that reason, **and over bypass everywhere** because the planner is
where a human should be asked.

## References

- `pipeline-cli/src/dispatch/` (board, sessions, reaper, supervisor);
  `ai-sdlc-plugin/commands/execute-parallel.md` (AISDLC-462);
  `ai-sdlc-plugin/commands/dispatch-worker.md`; `docs/operations/parallel-dispatch.md`;
  `docs/operations/dispatched-session-decisions.md` (AISDLC-480);
  `ai-sdlc-plugin/hooks/lib/governance-resolver.js`; `spec/schemas/agent-role.schema.json`.
- Claude Code docs: CLI reference (`--name`, `--model`, `--permission-mode`,
  `--append-system-prompt`), cross-session messaging (naming, held messages,
  `crossSessionInbound`), hooks (`SessionStart` matcher `clear`).
- [[RFC-0012]] (two-tier pipeline; why `execute` must run at the top level);
  [[RFC-0035]] (Decisions); [[RFC-0041]] (board protocol, billing pools, §9.3);
  [[RFC-0048]] (governance value types); [[RFC-0049]] (capabilities, judgment layer);
  [[RFC-0050]] (per-role usage).

## Sign-Off

| Role | Owner | Status |
| --- | --- | --- |
| Engineering | Dominique Legault | ✅ Signed (reuses the board, decisions and governance substrate; authority in policy, not messages; context emptied per task; 2026-09-30) |
| Operator | Dominique Legault | ✅ Signed (codifies the shape that worked in practice; throughput never waits on a typed confirmation; the human is asked last and deliberately; 2026-09-30) |
| Product | Alex | ⏸ Pending |
| Design | Morgan | ⏸ Pending |

## Revision History

| Date | Change |
| --- | --- |
| 2026-09-30 | Initial version, born `Signed Off` (Engineering + Operator). Codifies the planner / operator-dispatch / executor arrangement from the first RFC-0049/0050 parallel run and the gaps it surfaced. 3 Open Questions resolved via operator rubric walkthrough. Phase tasks AISDLC-663 to AISDLC-671. Trigger: operator request. |
