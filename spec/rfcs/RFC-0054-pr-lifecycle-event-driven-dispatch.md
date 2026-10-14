---
id: RFC-0054
title: PR Lifecycle as Event-Driven Dispatch (one state machine from branch pushed to merged)
status: Draft
lifecycle: Draft
author: 'Dominique Legault'
created: 2026-10-13
updated: 2026-10-14
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0012, RFC-0035, RFC-0041, RFC-0042, RFC-0051]
requiresDocs: []
---

# RFC-0054: PR Lifecycle as Event-Driven Dispatch (one state machine from branch pushed to merged)

**Status:** Draft
**Lifecycle:** Draft
**Author:** Dominique Legault (drafted by an agent session on the operator's 2026-10-13 mandate)
**Created:** 2026-10-13
**Updated:** 2026-10-13
**Target Spec Version:** v1alpha1

> This RFC presents options and a recommendation. It does not resolve any Open Question. Every
> question in the Open Questions section is routed through the decision rubric
> (`decision-rubric`, Decision Catalog RFC-0035); the answers are the operator's.

---

## Summary

Two state machines describe the same unit of work and are not connected: the GitHub pull request
(draft, checks running, red, green, ready, armed, merged, conflicting) and the Dispatch Board task
(`queue/`, `inflight/`, `done/`, `failed/`, `blocked/`). The board stops at "a draft PR exists";
GitHub keeps going for hours or days with no owner. Every transition after "draft PR exists" is
driven by a poll (a 300 s dispatch tick, a planner 30-minute survey), by a workflow whose events
skip most of the time, or by a person.

This RFC proposes making the PR lifecycle one explicit state machine, fed by an idempotent stream of
PR events, with exactly one owner for every transition from "branch pushed" until "merged". It
compares four ways to get the events (a GitHub webhook to a local receiver, GitHub Actions as the
event source, poll-based reconciliation, and a hybrid of webhook and poll) and recommends an order
of work that starts with deletions that need no new code. The operator's leading candidate, a
webhook that triggers the state machine, is evaluated on equal terms with the others.

Every automation proposed here follows the [Automation ladder](#automation-ladder-normative): deterministic first, structural second, a cheap decision model (JEV) only where structure cannot decide, and strong models only to plan and synthesize what a cheaper model executes.

The lifecycle, its watchdog dwell times and the happy and recovery sequences are drawn in
[Lifecycle and anti-stagnation](#lifecycle-and-anti-stagnation).

## Motivation

### The problem in one picture

| | GitHub PR state | Board task state |
|---|---|---|
| Branch pushed, no PR | (none) | `inflight/` |
| Draft PR created (Step 11) | draft, CI skipped | `done/` (verdict `success`) |
| Flipped ready, CI running | ready, checks pending | `done/` |
| Red (skew, real, flake) | `ai-sdlc/pr-ready` failure | `done/` or `failed/` |
| Green, not armed | ready, CLEAN | `done/` |
| Armed | auto-merge queued | `done/` |
| Merged | merged | `done/` (unchanged) |
| Conflicting / behind | DIRTY / BEHIND | `done/` (unchanged) |

The board has no state for any row below "draft PR created". The task is "done" while the PR is
still the unit of risk. The 2026-10-11 pile-up audit
(`docs/audits/2026-10-11-pr-pileup-dispatch-role-audit.md`) recorded this as Findings 1 to 6: no
owner follows a PR until it lands, three definitions of done coexist (executor `success` = PR open;
board `done/` = verdict written; CLAUDE.md Done semantics = task file moved), the hand-off happens
at the moment a PR is most likely to go red, and readiness depends on a phrase in the PR body.
DEC-0127 (operator, 2026-10-11) set the target: done means the PR is on main. AISDLC-816 carries
that rule as a to-do; as of this draft it is not implemented.

### The poll-only clock

Every transition after "draft PR exists" is driven by a clock, not by an event:

- The dispatch tick wakes on `nextWakeSec` (30 busy, 300 working, 1800 empty, per
  `ai-sdlc-plugin/commands/operator-dispatch.md`) and, in manual mode, only when a planner or
  operator message wakes it (AISDLC-823 context: the 2026-10-12 drain idled for two hours after its
  blocking PR merged).
- The planner's 30-minute survey was the only PR watch; it stopped at 04:25Z on 2026-10-11 and the
  open list grew from 24 to 32 (pile-up audit, Finding 1).
- The only code that reacts to a CI failure on an open PR, the ci-failure-watcher
  (`pipeline-cli/src/runtime/ci-failure-watcher.ts`, AISDLC-460), is a 60 s polling loop that is not
  started by any workflow or hierarchy role; its own header lists "webhook-based push notification"
  as a deferred Phase 2. AISDLC-829 proposes deleting it.
- The GitHub-side event consumers are workflows (`auto-enable-auto-merge.yml` fires on
  `pull_request_target`, `check_suite` and `status`); the CI/CD audit
  (`docs/audits/2026-10-13-cicd-five-step-audit.md`, F4) measured 624 of its 1000 runs as
  `check_suite` events at 5 s of job time and a 64 s median wall time, and it refuses drafts.

### Incident evidence, 2026-10-13

Verified against the board files in `.ai-sdlc/dispatch/` (parent checkout) unless marked otherwise.

| Task / PR | What happened | Evidence |
|---|---|---|
| AISDLC-549 (#1407) | Approved verdict, 29 unpushed commits (per the operator's incident log), requeue cap reached | `failed/AISDLC-549.manifest.json` has `retryCount: 2`; verdict 01:40Z says "Not pushed ... non-fast-forward; lease push ... refused by pre-push attestation-sign ... reviewer set incomplete". The 29-commit count is not in the verdict note. |
| AISDLC-742 (#1248) | Reviews approved 3/3; Step 10.5 stopped with `rebase-conflict` while no rebase was in progress; the worktree was dirty (4 deleted attestations, modified reviews and transcript leaves); branch 8 commits behind main | `failed/AISDLC-742.verdict.json` 01:21Z. The board shows `retryCount: 1`, not 2, so "same as 549" holds for the symptom (no sanctioned way back), not for the cap. |
| AISDLC-764 (#1368) | Step 0.5 refused: 12 untracked `.ai-sdlc/_decisions/events` files (DEC-0160..0165) in the parent; escalated as DEC-0166 | `failed/AISDLC-764.verdict.json` 04:34Z. The operator log also says the developer agent tried a refused push after a local rebase; that is not in the verdict note and is unverified here. |
| AISDLC-825 | Failed pre-push on missing `orchestrator/dist` and no task-citing commit subject | From the operator's log. The board shows 825 later in `done/` after a push-only resume (rebase, build, re-sign, lease push, ready flip). |
| AISDLC-827 (#1449) | Step 10.5 preSignRebase on a dirty worktree reported "conflict unknown" | From the operator's log; 827 is `inflight/` at step `05-dev-running` in the snapshot read. Unverified beyond the log. |
| Executor `alpha` | Reaped on stale heartbeat, not relaunched for hours | From the operator's log. AISDLC-826 (#1450, merged 2026-10-13) added stall detection and relaunch to the tick. |
| Four drafts 2 to 3 days old | Never flipped ready: the pipeline ends at "draft PR exists" and the auto-enable workflow refuses drafts | Pile-up audit Finding 4 records the same class on 2026-10-11 (#1402 to #1407). |
| PR lifetime | Median 42 min, p25 12 min, p75 356 min, 17 of 80 merged PRs over 12 h; code PRs are green 9 to 14 min after the last push | CI/CD audit section 1 and F1: "The crawl is landing, not CI." |
| Reachability | Dispatch could not act: executors are reachable only through the board, a resume signal requires an inflight claim, cross-session messages go only to the dispatch entry of the roster, and a `failed/` task past the retry cap has no sanctioned re-entry | `pipeline-cli/src/dispatch/resume.ts` (resume works on a `done/` task or an iterate-needed inflight claim), `requeue.ts` (retry limit), `planner.md` ("messages only the dispatch entry"), AISDLC-828 |
| Parent debris | Executors flip task status in the parent; dispatch's decision answers landed in the parent events log, which is what blocked 764's Step 0.5 | Board verdict for 764; AISDLC-825 (merged, #1454) addresses where decisions are filed from a task worktree. |

The pattern is the same in every row: the work that remains after "PR exists" is mechanical
(rebase, re-sign, lease push, flip ready, arm), is known to the repository (PR state is on GitHub,
task state on the board), and has no owner and no trigger.

## Goals

- One state machine for a task's PR, from "branch pushed" to "merged", with one named owner for every
  transition and one definition of done (DEC-0127).
- Every transition is triggered by an event or by a reconciliation that is safe to run at any time
  (idempotent), never by "someone noticing".
- A recovery path for every non-happy state (red, conflicting, stalled, past-retry-cap) that does not
  need a planner ruling when the shape is mechanical.
- Delete before adding: phase 0 removes requirements and mechanisms that need no new code.
- An approach that works on an operator laptop (NAT, sleep, rotating auth) and degrades to correct,
  slower behaviour when the laptop is closed.

## Non-Goals

- Changing the review pipeline, attestation format (RFC-0042) or the merge gate
  (`cli-merge-if-eligible`, `governance.allowMerge`). The state machine arms and merges only through
  existing sanctioned paths.
- Resolving the design questions below. This RFC lists them with options.
- Replacing the session hierarchy (RFC-0051) or the Dispatch Board (RFC-0041). The board gains
  states; its claim and ordering semantics stay.
- A multi-repository or SaaS control plane.

## Current tooling inventory

Clock column: **event** = reacts to a GitHub or filesystem event; **poll** = wakes on a timer;
**manual** = needs a person or another agent to start it.

| Component | Event it produces / consumes | Owner role | Clock | Recovery path when it fails |
|---|---|---|---|---|
| `ai-sdlc-gate.yml` (`ai-sdlc/pr-ready` rollup, 14 jobs) | Consumes `pull_request` opened/synchronize/reopened/ready_for_review; produces the required check | CI | event | Push again; executor resume with a note; `retrigger-ci` playbook action |
| `auto-enable-auto-merge.yml` | Consumes `pull_request_target`, `check_suite`, `status`; arms `--auto --squash` on same-repo PRs; refuses drafts | CI (acts as the PR author's PAT) | event, but 624 of 1000 runs are `check_suite` noise | Re-trigger by ready flip or a new push; no owner if it skips |
| `ai-sdlc-fix-ci.yml` | Consumes `workflow_run` completed; acts on failures of `ai-sdlc/issue-*` branches only (100% skipped over 7 days per the CI/CD audit F4) | CI | event | None observed; effectively dead |
| ci-failure-watcher (`pipeline-cli/src/runtime/ci-failure-watcher.ts`) then `ci-conflict-resolver` agent | Polls `gh pr list` every 60 s; classifies stale-base shapes; spawns the resolver (cap 2); 24 h cool-down file per PR | nobody (not started by any role; the only PR-failure to agent bridge in code) | poll, dormant | `/ai-sdlc resolve-conflicts <pr>` by hand; AISDLC-829 proposes deleting it |
| dependabot / CodeQL default setup / Scorecard / release-please (`release.yml`) | GitHub-native or push-main events; CodeQL runs on every PR (Go costs about 2 min, CI/CD audit F3); release-please keeps one rolling `chore: release main` PR | CI / operator (release merge is operator-only, DEC-0042) | event (Scorecard weekly cron) | Operator action; `cli-merge-if-eligible --source-kind release --arm` |
| `main-health-monitor.yml` / `ci.yml` | Push to main; nightly; opens `[main-health]` issue | CI | event + cron | Issue assigned to the operator |
| Dispatch Board (`.ai-sdlc/dispatch/{queue,inflight,done,failed,blocked}`) | Producers: dispatch (enqueue), executors (claim, verdict). Consumers: executors, tick | dispatch | filesystem state, claim is an atomic rename | `requeue` (retry limit 2), `resume` (needs a `done/` task or an iterate-needed claim), `reap` |
| Requeue + retry cap (`dispatch/requeue.ts`) | Increments `retryCount`; refuses past the limit (a "mistake guard", cap at most 2) | dispatch | manual (operator or tick playbook) | Planner ruling (AISDLC-828 proposes bypass when a PR is open) |
| Resume signal (`dispatch/resume.ts`) | Writes `<id>.resume.json` beside an inflight claim; the next claim reads the note | dispatch | manual | Only works with an inflight claim or a `done/` task |
| Reap / heartbeat (`dispatch/session-reaper.ts`, `hierarchy/stall.ts`, AISDLC-826) | Heartbeat per pipeline step; stale after 30 min (RFC-0041 OQ-3) or holder-not-busy grace; moves claim to `failed/` and requeues with a note naming the stalled step | dispatch tick | poll | Relaunch on the tick |
| `cli-hierarchy` roster / `tick` / `markReady` / `up` / `down` / `restart` / `clear` | Tick = ingest briefs, watch verdicts, run playbook on failures only, emit reports, `markReadyAfterCodeql`. `markReady` flips only drafts whose body says "draft until CodeQL is clean" (pile-up audit Finding 4) | dispatch | poll (300 s working; manual wake in practice) | Planner message wakes dispatch |
| Auto-clear Stop hook (AISDLC-766) | Clears a context at a usage threshold | each session | event (Stop hook) | Manual `/clear` |
| Cross-session UDS messaging and `check-sender` | Planner messages only the dispatch entry; executors accept instructions only from their roster's dispatch session by pid or harness ref; planner is held for the operator | hierarchy | event, but sender-gated | `cli-hierarchy check-sender` fails open with a warning when no pid or ref is reported |
| Step 0 to 13 pipeline | Ends at Step 11 (push, draft PR) and Step 13 (cleanup); Step 10.5 `preSignRebase` and `11-late-rebase` exist because the base moves during a 20 to 40 min dev run | executor | manual (runs once per claim) | Resume on a new claim |
| Pre-push hook chain (11 scripts: dark-code, squash chores, fixups, task-moved, attestation-sign, others) | Consumes `git push`; mutates the branch, then exits 1 so the push is repeated | executor | event (push) | `AI_SDLC_SKIP_*` or the master bypass (documented emergency only) |
| Attestation head-binding (RFC-0042, AISDLC-810) | Envelope subject must be an ancestor of HEAD or an attestation-only descendant; any rebase orphans the subject and forces a re-sign | executor / hook | event (push) | Hook re-signs from the verdict file with no reviewer round; with no verdict or `.active-task` the push fails and the review is repeated |
| `cli-merge-if-eligible` + governance PreToolUse hook | Sanctioned arm/merge path; the hook refuses raw merge commands, including `--auto` | dispatch / operator | manual call | AISDLC-816 AC-4 would have the tick call it |
| Decision Catalog (`cli-decisions`) | `decision-opened`, `operator-answered` events in `.ai-sdlc/_decisions/events/` | planner / dispatch | manual | `operator-digest` |

Observations the table makes visible:

1. Only the gate, the auto-enable workflow and the hooks are event-driven, and they act on a push or a
   CI result, not on a PR's lifecycle. Everything that closes a lifecycle gap is poll or manual.
2. The one component that bridges "CI failed on an open PR" to an agent is dormant code with no owner.
3. Four different retry or recovery vocabularies exist (requeue, resume, reap, resolve-conflicts)
   with different preconditions on board state; none is keyed on PR state.
4. The messaging rules (planner to dispatch only, executors accept only their dispatch) mean the only
   route to an executor is a board manifest or resume signal. That is intentional (RFC-0051 OQ-1) but
   it makes the board the only API, and the board has no PR states.

## Five-step pass (DEC-0090 order)

The Five-step review (requirements first) for this RFC, applied in order. Deletion candidates are
recommendations; any deletion that loosens a governance control is a class (b) decision for the
operator (see Open Questions).

### 1. Make the requirements less dumb

| Requirement | Set by | Question |
|---|---|---|
| "A task is done when its PR is open" | RFC-0012 Step 11 hand-back design, carried into RFC-0051's executor loop | Already replaced by DEC-0127 (operator, 2026-10-11). Not yet implemented (AISDLC-816, To Do). |
| "Retry cap of 2 on `requeue`" | `requeue.ts`, mistake guard | Written to stop churn on tasks that never produced a PR. Is it measuring the right thing? A PR follow-up is not a retry. |
| "A resume signal needs an inflight claim" | `resume.ts` precondition | Why does a mechanical finish need a claim? The claim is the executor's lease, not a prerequisite for a note. |
| "Dispatch acts only when woken by a message" | RFC-0051 assumption, planner 2026-10-06 (AISDLC-823) | Who benefits from the planner being the clock? |
| "Dispatch sends only what the board carries" | RFC-0051 OQ-1, operator | Keep. The question is only what the board is allowed to represent. |
| "mark-ready flips on a phrase in the PR body" | `mark-ready.ts` | A state test (CodeQL clean, not superseded) does the same job without the phrase (AISDLC-816 AC-9 area). |
| "Three definitions of done" | Accretion | One is enough. |
| "Executors flip task status in the parent" | Step 4 / `task_edit` Pattern C routing | The parent is read-only by rule; the flip is debris. |
| "Every push re-runs 9 to 10 workflows" | Accretion | Out of scope here; the CI/CD audit owns it. This RFC only asks that the event stream not depend on workflows that skip. |

### 2. Delete the part or process

Candidates, in rough order of confidence. "If you are not adding back 10% of what you deleted, you
did not delete enough": the likely add-back is named in brackets.

- The retry cap as a mistake guard on PR follow-ups. [Add back: a cap on consecutive failures of the
  same classified shape, which is a real runaway guard.]
- The "resume needs a claim" precondition. [Add back: resume of a task whose PR is merged or closed
  is refused.]
- The planner "tick" as a precondition for dispatch work. [Add back: the planner is still told about
  anything outside the operational list.]
- Three definitions of done; keep "PR on main" (DEC-0127).
- The dispatch tick as the thing that schedules itself and polls for everything; replace the many
  special cases with classification of PR state in one place.
- The dormant ci-failure-watcher and the `resolve-conflicts` command as a parallel PR-failure path
  (AISDLC-829 already proposes it).
- Duplicate parent status flips (executor `task_edit` in the parent).
- The `ai-sdlc-fix-ci.yml` branch-prefix filter (100% skipped in 7 days), as part of the CI/CD audit.

### 3. Simplify or optimise (only after step 2)

- One PR state classifier (a pure function from `{PR json, check runs, board record}` to one state)
  and one action table. AISDLC-823 already contains such a table; this RFC makes it the contract.
- One owner per transition (see the ownership table below).
- One event schema with an idempotency key, whatever the source.
- Merge the board verdict into the PR state: `done/` is written only on `merged`; `landing/` is the
  state between "PR exists" and "merged" (AISDLC-816 AC-2).

### 4. Accelerate cycle time (only after steps 1 to 3)

- A red or conflicting PR returns to the board within one event (or one reconciliation) instead of
  one planner ruling.
- Arm and ready-flip on the first green observation, not on the next tick.
- Run the mechanical finish (rebase, re-sign, lease push) as a deterministic script without a model
  turn where the shape is known (stale attestation subject, stale base). Mechanical work should not
  be wrapped in subagents (CLAUDE.md, subagent model defaults).

### 5. Automate (last, never first)

- Event delivery (webhook, forwarder, workflow, or reconciler) is the automation step. It is last on
  purpose: with phase 0 and the state machine in place, a 5-minute poll already closes most of the
  gap, and the event source is an optimisation of latency, not of correctness.

**Velocity impact.** Positive by construction: phase 0 removes work, the state machine removes the
planner round trip for mechanical PR stops (ten of eleven resumes on 2026-10-11 were the same ruling,
pile-up audit Finding 6), and the median 42 minute lifetime is dragged to hours by the p75 tail that
this RFC targets. Costs are listed per option below.

## Proposal

### The state machine

States for the PR of one task. The state is derived, never stored as the only copy: it can always be
recomputed from `{GitHub PR, check runs, board record}`.

```
branch-pushed -> draft-pr -> ci-running -> green -> ready -> armed -> merged
                                  |           ^        ^
                                  v           |        |
                     red(skew | real | flake) +--------+
                                  |
                     conflicting (DIRTY/BEHIND)  --- any state may enter
                     stalled (no heartbeat / no owner) --- any non-terminal state may enter
                     closed-unmerged (terminal, flagged: KPI per memory note)
```

Ownership table (proposal; Open Question 2 asks whether to approve it):

| Transition | Event that triggers it | Owner | Action |
|---|---|---|---|
| branch-pushed to draft-pr | Step 11 push + PR create | executor | Step 11 (unchanged) |
| draft-pr to ci-running | `ready_for_review`, or push on a ready PR | state machine | Flip ready when CodeQL is clean and the verdict is approved (by state, not phrase) |
| ci-running to green / red | `check_suite` or `workflow_run` completed, or `ai-sdlc/pr-ready` status | CI | none (observed) |
| red(skew) | classified: stale base, stale attestation subject, cancelled/superseded check | state machine | Mechanical finish: rebase, drop the stale envelope, lease push so the hook re-signs; no reviewer round |
| red(real) | classified: test, lint, coverage failure on the current head | executor (the one that made the PR), by resume with the failing line | Fix, re-review, push |
| red(flake) | classified: infra, cancelled with no newer run | state machine | Retrigger once, then reclassify |
| green to ready to armed | first green observation on a CLEAN PR | state machine | `cli-merge-if-eligible --arm` under the existing grant |
| armed to merged | `pull_request` closed with `merged: true` | GitHub | State machine writes `done/`, syncs the parent, releases the next claim (DEC-0127) |
| any to conflicting | `mergeStateStatus` DIRTY/BEHIND | state machine | Rebase path as above; if semantic, return to the executor |
| any to stalled | heartbeat/owner absent beyond threshold (AISDLC-826) | state machine | Reap, relaunch, resume with a note naming the step |

### What is common to every option

Whatever the source of events, three properties hold (they are the part of the design that is not
in question):

1. **Event record.** A PR event becomes a file in a board-adjacent directory
   (`.ai-sdlc/dispatch/events/`), named by an idempotency key
   `<repo>#<pr>@<headSha>:<event-kind>:<delivery-or-updatedAt>`, containing only fields GitHub
   supplied. Ingest is create-if-absent; replays are no-ops.
2. **Reconciliation is always possible.** The classifier can be run over `gh api` REST output at any
   time and must produce the same state the events would have produced. No option may make events the
   only source of truth.
3. **Actions use sanctioned paths.** Arm via `cli-merge-if-eligible --arm`; push via the lease-push
   form; re-sign via the attestation hook; no new bypass.

## Design options

### Option A: GitHub webhook to a local receiver

**Event source.** A GitHub repository webhook (events: `pull_request`, `check_suite`, `check_run`,
`workflow_run`, `status`, `pull_request_review`) delivered to a local listener. Delivery paths:
`gh webhook forward` (a developer-oriented CLI extension that opens a websocket and forwards to a
localhost URL), a smee.io-style relay, or a tunnel to a tiny HTTP listener in `pipeline-cli`. The
receiver validates `X-Hub-Signature-256` (HMAC with a shared secret) and writes the event record.
The tick wakes on a new record (filesystem watch), classifies, acts.

**State machine and owners.** As in the table above; the receiver only writes events, the
dispatch-owned machine acts.

**Recovery.** None built in: if the laptop sleeps or the forwarder drops, events are lost.
GitHub keeps recent deliveries for redelivery (the delivery log is retrievable through the API for a
limited time; exact retention is not verified here), so a catch-up pass is possible, but it is a
reconciliation by another name.

**Failure modes.** Forwarder disconnect; secret rotation; duplicated or out-of-order deliveries
(handled by the idempotency key and by re-reading the PR); a listener that accepts untrusted bodies
(must verify the signature before parsing); a public relay seeing PR metadata.

**Cost.** Tokens: none for ingest (receiver is deterministic). Runner minutes: zero. Operator
attention: set up and keep a forwarder alive; maintain a webhook secret; a new always-on process on
the laptop (similar to the roster sessions it would sit beside).

**Blast radius.** A compromised or misconfigured receiver can inject events. Mitigation: events are
hints that trigger a re-read from GitHub through authenticated REST; no action is taken on payload
contents alone.

**What it deletes.** The poll interval as the clock; the dormant ci-failure-watcher; the planner
survey as a PR watch.

### Option B: GitHub Actions as the event source

**Event source.** A single small workflow (`pull_request`, `workflow_run`, `check_suite`) classifies
the PR on GitHub's side and writes the state where the local machine can read it with one cheap call,
without an inbound connection. Candidate sinks (each with a downside): a PR label such as
`lifecycle:red-skew` (visible, human-readable, rate-limited and noisy in timelines); a commit status
or check run (no repo write, but ephemeral per SHA); a comment (dedup problems); a commit to a
`events` branch (history noise and write permissions); `repository_dispatch` (needs a consumer, which
is a poll again). The local tick lists PRs with one REST call and reads the sink.

**State machine and owners.** Classification moves to CI; actions that need the signing key,
worktrees or the plugin stay local (see the read-only remote-agent constraints in CLAUDE.md); CI-side
actions are limited to labels, retriggers and ready flips.

**Recovery.** If the workflow is skipped (path filters, runner queue, the 5 s job with a 64 s queue
wait measured by the CI/CD audit), the next reconciliation reads PRs directly.

**Failure modes.** Workflow permission and `GITHUB_TOKEN` limits (actions taken by `GITHUB_TOKEN` do
not trigger further workflows); queue latency during the exact periods that matter (a 150-run queue
was observed on 2026-10-10); another workflow added to a repository whose audit says there are too
many.

**Cost.** Tokens: none. Runner minutes: small per event but nonzero (the audit counts runner minutes
as a pressure). Operator attention: one more workflow to keep correct; no always-on local process.

**Blast radius.** Workflow with write permission on PRs; `pull_request_target` carries the usual
untrusted-code cautions. Smallest inbound surface of the four.

**What it deletes.** The ci-failure-watcher; the `check_suite`-triggered auto-enable noise if the new
workflow absorbs arming for the CI side.

### Option C: Poll-based reconciliation (the minimal change)

**Event source.** None external. `cli-hierarchy tick` already wakes on `nextWakeSec`; it additionally
runs `gh pr list --state open --json number,headRefName,isDraft,mergeStateStatus,statusCheckRollup`
(or REST `pulls` plus `check-runs` for the roster's PRs), diffs against the stored per-PR state, and
emits the same event records the other options would write. This is the AISDLC-823 and AISDLC-829
design (15-minute or 300 s poll, REST only, classifier in `pipeline-cli/src/hierarchy/`).

**State machine and owners.** As in the table. The tick is the only actor.

**Recovery.** Self-healing by construction: each tick recomputes state from GitHub.

**Failure modes.** Latency equal to the interval; API rate limit (one list call per tick is far below
limits); a tick that is not scheduled (the AISDLC-823 problem: nothing wakes dispatch) so the
scheduling requirement is part of this option; a PR with no task id (filing PRs) is reported, not
requeued.

**Cost.** Tokens: none for the poll, a model turn only when an action needs judgment. Runner
minutes: zero. Operator attention: lowest, no new process or secret.

**Blast radius.** Smallest: authenticated pull with the operator's existing `gh` token, no inbound
surface.

**What it deletes.** The ci-failure-watcher; the planner survey; the "message wakes dispatch"
assumption (if the tick schedules itself).

### Option D: Hybrid, webhook when a listener is up, poll as the fallback reconciler

**Event source.** Options A or B feed the same event directory as Option C. Events are hints;
the poll runs at a longer interval (for example 15 minutes) when a listener is healthy and at the
short interval when it is not. All ingestion is idempotent, so double delivery is harmless.

**State machine and owners.** Identical to C; the only addition is a listener health signal that
chooses the poll interval.

**Recovery.** The reconciler covers every gap (laptop closed, forwarder down, workflow skipped).

**Failure modes.** The union of A or B and C, with the benefit that none of them is load-bearing for
correctness. The added risk is operational: two paths to test, and the temptation to treat the fast
path as the real one.

**Cost.** Tokens: none. Runner minutes: zero (A) or small (B). Operator attention: the listener
setup of A or B, plus nothing for correctness.

**Blast radius.** That of the chosen event source, limited because events never carry authority.

**What it deletes.** Same as C, plus the poll interval as the latency floor.

### Comparison

| Criterion | A: webhook to local | B: Actions as source | C: poll reconcile | D: hybrid |
|---|---|---|---|---|
| Latency to react | Seconds to tens of seconds when connected | A workflow queue wait (64 s median measured for a 5 s job; spikes to a long queue) plus the local read interval | The poll interval (60 to 300 s; 15 min proposed in AISDLC-823) | Seconds when the fast path is up, else C |
| Works on an operator laptop (NAT, sleep, auth) | Needs a forwarder or tunnel; websocket and tunnels drop on sleep; secret to manage | Yes; no inbound connection; needs a local read | Yes; needs only `gh` auth | Yes; degrades to C |
| Laptop closed | Events lost until reconciliation | Events stored on GitHub (labels/statuses) and read on wake | Nothing happens; first poll on wake catches up | Same as C |
| Security surface | Inbound HMAC-validated endpoint or relay; secret rotation; payload parsing | Workflow with write permission; `pull_request_target` caution; no inbound | None new (authenticated pull) | That of the fast path chosen |
| Idempotency | Required (redelivery, out of order); key by delivery id plus head SHA | Required (re-run, cancelled runs) | Natural (recompute) | Required, shared ingest |
| New moving parts | Receiver/forwarder, secret, health check | One workflow, sink convention | Classifier and a scheduling guarantee | All of the chosen path plus C |
| Runner minutes | 0 | Small, nonzero | 0 | 0 or small |
| Operator attention | Moderate (keep it up, rotate secret) | Low-moderate | Lowest | Moderate (but optional) |
| Deletes | Poll clock, watcher | Watcher, some workflow noise | Watcher, planner survey | Same as C plus latency floor |
| Failure when broken | Silent gap until reconcile | Silent skip until reconcile | Slow, but visible | Slow, visible |

## Lifecycle and anti-stagnation

These diagrams depict the **recommended design** (Option C as the core, a fast path later, per the
Recommendation below). They are illustrations of that recommendation, not decisions: where an Open
Question changes the picture, the note says "per OQ-n" and the diagram shows the recommended answer
only as a placeholder. Legend: `[today]` marks a transition that exists now (possibly driven by a
person or a poll); `[new]` marks a transition this RFC proposes. Owners: executor, dispatch (the
tick), SM (the proposed state machine, which runs inside dispatch per OQ-2 and OQ-8), GitHub,
operator. Dashed-border states in the first diagram are new.

### 1. State diagram: one unit of work from intake to main

The diagram follows one task from filing to a landed PR with the parent checkout fast-forwarded and
the task file in `backlog/completed/`. The side states (Conflicting, Stalled, Failed, Parked) can be
entered from any non-terminal state; to keep the picture readable they are drawn from the state
where they most often occur, and the anti-stagnation table below lists the entry rules. Failed means
the board `failed/` directory; Parked means a decision is open for the operator.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Filed : task or issue filed [today] planner
    Filed --> DoR : filing PR landed [today] dispatch
    DoR --> Held : verdict needs-clarification [today] dispatch
    DoR --> Queued : verdict ready [today] dispatch
    Held --> DoR : task edited [today] planner
    Queued --> Claimed : executor claims, worktree made [today] executor
    Claimed --> Developing : Step 5 dev spawned [today] executor
    Developing --> Reviewing : dev returns [today] executor
    Reviewing --> Developing : changes requested [today] executor
    Reviewing --> Signed : 3 approvals, leaves emitted [today] executor
    Signed --> DraftPR : Step 11 push [today] executor
    DraftPR --> CIRunning : ready flip by state test [new] SM
    CIRunning --> Green : pr-ready success [today] GitHub
    CIRunning --> RedSkew : stale base or subject [new] SM
    CIRunning --> RedReal : test lint coverage fail [new] SM
    CIRunning --> RedFlake : infra or cancelled [new] SM
    RedSkew --> Signed : rebase and re-sign follow-up [new] SM
    RedFlake --> CIRunning : retrigger once [new] SM
    RedReal --> Developing : fix round resume [new] SM
    Green --> Ready : CLEAN and approved [new] SM
    Ready --> Armed : arm via sanctioned CLI [new] SM
    Armed --> Merged : PR closed as merged [today] GitHub
    Merged --> Landed : parent ff and task completed [new] SM
    Landed --> [*]

    CIRunning --> Conflicting : mergeState DIRTY or BEHIND [new] SM
    Armed --> Conflicting : mergeState DIRTY [new] SM
    Conflicting --> Signed : rebase and re-sign [new] SM
    Conflicting --> Developing : semantic conflict, files named [new] SM
    Claimed --> Stalled : no heartbeat 30 min [today] dispatch
    Developing --> Stalled : no heartbeat 30 min [today] dispatch
    Reviewing --> Stalled : no heartbeat 30 min [today] dispatch
    Stalled --> Queued : reap and relaunch with note [today] dispatch
    Developing --> Failed : verdict failed [today] executor
    Failed --> Queued : follow-up requeue, no cap [new] SM
    RedReal --> Parked : 3 follow-ups used [new] SM
    Conflicting --> Parked : 3 follow-ups used [new] SM
    Failed --> Parked : second reaction failed [new] SM
    Held --> Parked : held beyond 24 h [new] SM
    Parked --> Queued : operator answers decision [today] operator

    classDef proposed stroke-dasharray: 5 5
    class RedSkew,RedReal,RedFlake,Ready,Armed,Landed,Conflicting,Parked proposed
```

Transition and owner reference:

| Transition | Event | Owner | Today or new |
|---|---|---|---|
| Filed to DoR | filing PR landed, DoR check runs | dispatch | today (DoR is a CI check plus the tick) |
| Queued to Claimed | atomic rename into `inflight/` | executor | today |
| Reviewing to Signed | 3 verdicts approve, leaves emitted, attestation signed | executor | today |
| Signed to DraftPR | Step 11 push and PR create | executor | today |
| DraftPR to CIRunning | draft flipped ready by a state test (CodeQL clean, verdict approved) | SM | new (today a phrase in the PR body, AISDLC-816) |
| CIRunning to Green or Red | `ai-sdlc/pr-ready` conclusion | GitHub | today for the check, new for the classification |
| Red and Conflicting reactions | classifier output | SM | new (replaces planner rulings and the dormant watcher) |
| Ready to Armed | first green on a CLEAN PR | SM | new (today `auto-enable-auto-merge.yml` skips drafts and noisy events) |
| Merged to Landed | merged event or reconcile | SM | new (DEC-0127, AISDLC-816) |
| Stalled to Queued | heartbeat stale 30 min | dispatch | today (AISDLC-826) |
| Parked to Queued | decision answered | operator | today |

Per OQ-2 the SM owner is a placeholder for whoever OQ-2 names; per OQ-5 `Landed` may split into
`delivered` and `landed`; per OQ-7 the push and the draft step may move into the machine.

### 2. Anti-stagnation table

Every state has a maximum dwell time, a detector, an automatic reaction and an escalation if the
reaction fails twice. Dwell numbers are proposals derived from measurements in this RFC: CI median
13 min (code PRs green 9 to 14 min after the last push), main moves about every 18 min, tick 5 to 30
min, heartbeat stale at 30 min. A watchdog fires at the max dwell; the reconcile pass runs at least
every tick, so detection latency is at most one tick. Only Parked waits on a person, and it always
carries a line in the operator digest (`cli-decisions operator-digest`).

| State | Max dwell | Detector | Automatic reaction (who) | If it fails twice | 2026-10-13 failure seen here |
|---|---|---|---|---|---|
| Filed | 30 min | poll reconcile: filing PR landed, no board record | dispatch ingests the brief, runs DoR | Parked with digest line | filing PRs the planner cannot lease-push (memory: filing hygiene) |
| DoR | 15 min | poll reconcile: DoR result present, task not routed | dispatch routes to Queued or Held | Parked | none seen |
| Held | 24 h | poll reconcile: held task, no edit | dispatch sends the DoR violations to the planner, who edits the task | Parked (digest names the violations) | none seen |
| Queued | 30 min with an idle executor | poll reconcile: eligible task, idle executor, no claim | dispatch hands the next task to the idle executor | relaunch executor, then Parked | alpha reaped and not relaunched for hours |
| Claimed | 10 min | heartbeat: no step recorded after claim | dispatch reaps and relaunches with a note naming the step | Failed, then follow-up | AISDLC-764 Step 0.5 refused over parent debris |
| Developing | 60 min, or heartbeat stale 30 min | heartbeat | dispatch reaps, relaunches, resumes from the last good step | Failed, follow-up | AISDLC-827 stale worktree during dev |
| Reviewing | 45 min, or heartbeat stale 30 min | heartbeat | dispatch reaps, relaunches, resumes from existing leaves (no new reviewer round if leaves match HEAD) | Failed, follow-up | AISDLC-549 reviewer set incomplete |
| Signed | 10 min | poll reconcile: verdict signed, branch not pushed | SM runs the push-only follow-up: rebase, build, re-sign, lease push (Step 10.5 dirty worktree fixed per AISDLC-848) | Failed, follow-up, then Parked | AISDLC-742 dirty worktree at Step 10.5; AISDLC-825 missing dist; 549 unpushed commits |
| DraftPR | 10 min | webhook or poll reconcile: draft, verdict approved, CodeQL clean | SM flips ready by state test | Parked | four drafts 2 to 3 days old |
| CIRunning | 30 min (about 2.3x the 13 min median) | Actions status or poll: checks pending beyond dwell | SM retriggers once, then reclassifies | Parked with the run link | auto-enable noise: 624 of 1000 runs were check_suite |
| RedSkew | 15 min | webhook or poll: failure classified skew | SM requeues a follow-up: rebase, drop stale envelope, lease push, hook re-signs | Parked after 3 follow-ups | stale attestation subject after a rebase |
| RedReal | 20 min to resume | webhook or poll: failure classified real | SM resumes the executor with the failing line; fix round | Parked after 3 follow-ups | no automatic path today |
| RedFlake | 15 min | webhook or poll | SM retriggers once | reclassify as real, then fix round | cancelled and superseded checks |
| Green | 5 min | webhook or poll: green, not ready or not armed | SM marks Ready and arms in the same pass | Parked | green drafts never flipped |
| Ready | 5 min | poll reconcile: ready and CLEAN, not armed | SM arms via `cli-merge-if-eligible --arm` | Parked (check the grant) | auto-enable skipped some events |
| Armed | 45 min (main moves about every 18 min, so two to three rebase windows) | poll: armed, not landed | SM checks mergeState: BEHIND or DIRTY enters Conflicting; otherwise re-arm | Parked | armed PRs stuck behind a moving base |
| Conflicting | 20 min | webhook or poll: DIRTY or BEHIND | SM mechanical rebase and re-sign; semantic conflict returns to the executor naming the files | Parked after 3 follow-ups | AISDLC-742 branch 8 commits behind |
| Merged | 10 min | merged event or poll | SM fast-forwards the parent, completes the task file, writes `done/` | Parked | parent debris blocking 764 |
| Stalled | 30 min heartbeat stale (existing) | heartbeat | dispatch reaps and relaunches (AISDLC-826) | Failed, follow-up | alpha not relaunched |
| Failed | 15 min | poll: task in `failed/` with an open PR or branch | SM follow-up requeue with no retry cap (per OQ-3) and a note naming the stalled step | Parked | 549 past the cap, no sanctioned re-entry (AISDLC-828) |
| Parked | no timer; digest every tick | operator digest | none by design: the digest line names the decision and the next step | n/a | DEC-0166 for 764 |

### 3. Sequence diagrams

#### 3a. Happy path

The path of one task from brief to landed, with the machine acting at each point where the executor
used to stop (per OQ-2 and OQ-7 the exact owner of ready and arm may differ).

```mermaid
sequenceDiagram
    autonumber
    participant Op as Operator
    participant Pl as Planner
    participant D as Dispatch and SM
    participant B as Board
    participant E as Executor
    participant GH as GitHub
    participant P as Parent checkout
    Op->>Pl: ask
    Pl->>D: brief, filing PR landed
    D->>B: enqueue after DoR
    E->>B: claim task
    E->>E: Steps 0 to 10, 3 reviews, sign
    E->>GH: Step 11 push, draft PR
    E->>B: verdict success, state landing
    GH-->>D: CI events or reconcile poll
    D->>GH: ready flip when CodeQL clean (new)
    GH-->>D: pr-ready success
    D->>GH: arm via cli-merge-if-eligible (new)
    GH-->>D: merged event
    D->>P: fast-forward parent (new)
    D->>B: complete task, write done (new)
    D-->>Op: digest line
```

| Step | Owner | Today or new |
|---|---|---|
| 1 to 4 intake and claim | planner, dispatch, executor | today |
| 5 to 7 build, review, push | executor | today |
| 8 board state `landing` | executor writes, SM owns | new (AISDLC-816) |
| 10 to 13 ready, arm | SM | new |
| 14 to 16 land | SM | new (DEC-0127) |

#### 3b. Recovery path: main moved, or the PR went red

The loop is a follow-up, not a retry: each pass is classified from GitHub facts, runs a bounded
mechanical or fix action, and goes back to CI. The bound is 3 follow-ups per PR, after which the PR is
Parked and one digest line names the last classification. The bound value and its scope are per OQ-3.

```mermaid
sequenceDiagram
    autonumber
    participant Op as Operator
    participant D as Dispatch and SM
    participant B as Board
    participant E as Executor
    participant GH as GitHub
    participant P as Parent checkout
    GH-->>D: pr-ready failure, or main moved
    D->>GH: read PR, checks, mergeState
    D->>D: classify skew, real, flake, conflict
    alt skew or main moved
        D->>B: requeue follow-up, push only (AISDLC-847)
        E->>B: claim follow-up
        E->>E: Step 10.5 commits leaves first (AISDLC-848)
        E->>GH: rebase, re-sign, lease push
    else real failure
        D->>B: resume with failing line
        E->>E: fix round, re-review
        E->>GH: push
    else conflict
        D->>B: resume naming conflicting files
        E->>GH: resolve, re-sign, push
    else flake
        D->>GH: retrigger once
    end
    GH-->>D: CI result
    alt green
        D->>GH: ready and arm
        GH-->>D: merged
        D->>P: fast-forward, complete task
    else red again, under 3 follow-ups
        D->>D: classify again
    else 3 follow-ups used
        D->>Op: Parked, digest line
    end
    opt dirty worktree at Step 10.5
        E->>D: verdict failed, step named (AISDLC-848)
        D->>B: follow-up requeue, no cap
    end
    opt heartbeat lost
        D->>E: reap, relaunch, resume with note
    end
```

| Branch | Detector | Reaction | Bound | Escalation |
|---|---|---|---|---|
| Skew or main moved | CI red event or mergeState BEHIND | push-only follow-up (AISDLC-847) | 3 per PR | Parked with digest |
| Real failure | pr-ready failure on current head | fix round via resume | 3 per PR | Parked |
| Conflict | mergeState DIRTY | named files to executor | 3 per PR | Parked |
| Flake | cancelled or infra with no newer run | one retrigger, then reclassify | 1 | reclassify as real |
| Dirty worktree at Step 10.5 | executor verdict names the step | follow-up requeue (AISDLC-848) | counts toward 3 | Parked |
| Heartbeat lost | stale 30 min | reap and relaunch | 2 relaunches | Failed then Parked |

## Automation ladder (normative)

This section records an operator rule (2026-10-13) as a design principle of this RFC. It is a
principle for how every automation proposed here and in later phases is built; it is not the
resolution of any Open Question.

> Apply deterministic automations first, structural automations second. If and only if an LLM
> automation is needed, consider a cheap decision model (JEV) first. If more context or a fallback
> for JEV is needed, use a Haiku model with a tightly scoped prompt fed with the data from the
> structural automation. If a strong thinking model is needed, use it only to PLAN what a cheaper
> model can execute, execute with the cheaper model, then SYNTHESIZE the result with the strong
> model, the same way the staged review is planned (`review-planner`, then `review-executor` on
> Haiku, then `review-synthesizer`). Keep prose automations to a minimum, with tightly scoped
> parameters.

**JEV.** The repository defines Jev as the first provider of the System One Judgment Layer: a
cheap closed-set classifier behind typed questions, pinned to an exact model version (for example
`jev-1.13.0`), shadow-first (`spec/rfcs/RFC-0049-system-one-judgment-layer.md`,
`docs/operations/judgment-layer.md`). RFC-0052 states its limit: "Jev cannot write a finding or
follow a call chain" (`spec/rfcs/RFC-0052-staged-review-pipeline.md`). Rung 2 below is therefore
the judgment layer; whether any other provider may fill rung 2 is OQ-12.

**The plan/execute/synthesize pattern** is the one RFC-0052 specifies and the plugin implements:
`ai-sdlc-plugin/agents/review-planner.md` turns a ranked risk map into a probe plan (read, grep,
glob and write only, no shell, no edit); `ai-sdlc-plugin/agents/review-executor.md` runs one
read-only probe and returns evidence as a fixed JSON shape (read, grep, glob only; Haiku per the
CLAUDE.md model pins); `ai-sdlc-plugin/agents/review-synthesizer.md` produces the verdict from
that evidence, every finding citing evidence. The strong model never touches the code directly and
the cheap model never decides the verdict.

### The five rungs

0. **Deterministic.** Code, git and gh state, file and path tests, exit codes. No model.
   Inputs: the repository, the git object store, a single `gh` read. Outputs: a boolean or an
   enum from code. Cost class: free, microseconds to seconds. Move up when: the decision needs a
   value no field, path, count or exit code carries.
1. **Structural.** A schema or state-machine decision over structured data already fetched (board
   JSON, PR JSON, check-run conclusions, `mergeStateStatus`, dwell timers, heartbeat ages). Still
   no model. Inputs: typed records. Outputs: a state-machine transition or a typed reaction.
   Cost class: free. Move up when: the answer depends on meaning the structure does not carry
   (for example whether a red check is a real failure) after the structured fields are exhausted.
2. **Cheap decision model (JEV).** Bounded classification over structured fields with a fixed
   label set, asked as a typed question. Inputs: rung-1 fields, never raw logs. Outputs: one label
   from the closed set plus a confidence, validated by schema. Cost class: fractions of a cent per
   question, shadow-first. Move up when: the labels are not enough because the case needs text
   the structured fields lack, or JEV is unavailable or below its confidence floor.
3. **Haiku, tightly scoped.** Only when rung 2 lacks context or as its fallback. The prompt is a
   template whose parameters are the rung-1 structured data; the output has a fixed schema; no
   free prose in or out. Cost class: cents per call, bounded by input size. Move up when: the task
   is generation or multi-step reasoning (writing a fix, resolving a semantic conflict), not
   extraction or labelling.
4. **Strong model, plan/execute/synthesize only.** The strong model writes the plan, a cheaper
   model executes each step, the strong model synthesizes the result. Never a strong model
   executing directly. Cost class: dollars per run, justified only by a real failure or a
   semantic conflict that rungs 0 to 3 provably could not decide.

**The rule.** A rung is used only when the rung below provably cannot decide. "Provably" means the
design names the case the lower rung fails on, and the lower rung's output for that case is
logged. Every prose automation (any step where a model reads or writes free text) must declare its
rung, its input schema, its output schema and its parameter bounds (maximum input size, maximum
calls per state dwell, maximum retries); an automation without that declaration is not admitted.

### Reclassification of the anti-stagnation reactions

Every reaction in the anti-stagnation table above, by the lowest rung that can decide it. Where
the rung is 0 the "why not lower" column explains why no model is needed.

| State | Reaction | Rung | Why not a lower rung |
|---|---|---|---|
| Filed | dispatch ingests the brief, runs DoR | 0 | Nothing lower exists; the ingest is a file read and DoR Stage A is deterministic (Stage B keeps its existing rung under RFC-0011) |
| DoR | route to Queued or Held | 1 | The DoR result is a typed verdict; routing is a table lookup, not a file or exit-code test |
| Held | send DoR violations to the planner, who edits the task | 1 | The violation list is typed; editing the task is a planner decision outside the machine |
| Queued | hand the next task to an idle executor | 1 | Eligibility, idle state and claim are board fields, a record rather than a single test |
| Claimed | reap and relaunch with a note naming the step | 1 | Heartbeat age and last recorded step are fields; the note is a typed requeue reason |
| Developing | reap, relaunch, resume from the last good step | 1 | Same fields; the resume point is a recorded step id |
| Reviewing | reap, relaunch, resume from existing leaves | 0 | Leaf-to-HEAD match is a hash comparison |
| Signed | rebase, build, re-sign, lease push | 0 | Exit-code driven commands; the pre-push hook already re-signs |
| DraftPR | flip ready by state test | 0 | Draft flag, verdict file and CodeQL conclusion are read directly |
| CIRunning | retrigger once, then reclassify | 1 | Pending age against the dwell is a timer, the retrigger count a counter on the record |
| Red (skew, real, flake) | classify the failure | 2 | Check names and changed paths decide most cases at rung 1 (a known-name table: stale attestation, cancelled, superseded). The residue (a check name not in the table, a diff touching both a failing test and unrelated paths) needs a closed-set judgment, which is JEV's job |
| RedSkew | requeue follow-up: rebase, drop stale envelope, lease push | 0 | Fixed command sequence once classified |
| RedFlake | retrigger once | 0 | One gh call once classified |
| RedReal | name the failing line and a fix hint from the log | 3 | Needs text from the log that no structured field holds; Haiku with check name, log tail and diff paths as parameters, output `{line, file, hint}` |
| RedReal | the fix round itself | 4 | Writing code is generation; an executor developer round, planned, executed and synthesized (below) |
| Green | mark Ready and arm | 0 | Check conclusions and `mergeStateStatus` are read directly |
| Ready | arm via `cli-merge-if-eligible --arm` | 0 | The CLI derives eligibility from GitHub |
| Armed | check mergeState; BEHIND or DIRTY enters Conflicting, else re-arm | 1 | A transition table over `mergeStateStatus` |
| Conflicting | mechanical rebase and re-sign | 0 | git exit codes; the mechanical class is pattern-based |
| Conflicting | semantic conflict, return to the executor naming the files | 4 | A semantic resolution is generation; the file list is rung 0, the resolution is a developer round |
| Merged | fast-forward the parent, complete the task file, write `done/` | 0 | Commands and file moves |
| Stalled | reap and relaunch | 1 | Heartbeat age against a threshold |
| Failed | follow-up requeue with a note naming the stalled step | 1 | A failed record with an open PR or branch; the note is the typed reason |
| Parked | digest line naming the decision and the next step | 1 | The line is rendered from a template over the typed park reason; no model writes it |

Counts over the 24 reactions above: rung 0 = 10, rung 1 = 10, rung 2 = 1, rung 3 = 1, rung 4 = 2.
Twenty of the 24 need no model at all.

**Rung 4 for the real-failure fix round and semantic conflict resolution.** Both run as an
executor developer round structured as plan, execute, synthesize: the strong model reads the
failure facts (the rung-3 output, changed paths, the task's acceptance criteria) and writes a plan
of bounded steps; a cheaper model executes each step in the worktree; the strong model
synthesizes whether the acceptance criteria and the failing check now hold, and the result still
goes through the existing reviewer fan-out and attestation. The strong model does not edit code.
Whether the current developer role (Sonnet) is the "cheaper model" here, or the pattern needs a
new planner, executor, synthesizer trio for development, is OQ-14.

### Minimising prose automations

The prose automations the RFC and the current hierarchy rely on, and the rung-0/1 mechanism that
replaces each. This follows the delete-first list above: prose is removed before it is optimised.

| Prose automation today | Replaced by (rung) |
|---|---|
| Dispatch playbook prose (instructions in `ai-sdlc-plugin/commands/operator-dispatch.md` and `pipeline-cli/src/hierarchy/playbook.ts` that a model reads each tick to decide the next action) | The state machine's transition table, run by the tick; the model is not asked what to do for any state with a row (rung 1) |
| Resume notes in prose (a free-text note attached to a requeue) | A typed requeue reason with a closed `kind` set: `{kind: stalled-step, red-real, conflict, skew; step; pr; headSha}`; the executor reads fields, not a paragraph (rung 1) |
| PR comments as instructions (a comment an agent reads as a command) | Typed resume signals with a fixed field set written to the board record; comments stay for humans and are never parsed as instructions (rung 1) |
| Planner rulings in chat for operational questions | A decision record in the catalog for class (a) and (b) rulings (existing `cli-decisions` rubric), and a state-machine row for the recurring ones so the same question is never asked twice (rung 1) |
| An agent reading a whole CI log to say what failed | Rung 2 for the label, rung 3 for the line, with the log tail bounded and the parameters declared (rung 3) |
| Operator digest lines written by hand | A template over the typed park reason (rung 1) |

What remains as prose after this pass is generation (code, task bodies, review findings) and the
operator's own decisions. Each remaining use declares its rung under the rule above.

## Recommendation (the RFC may recommend; it may not resolve)

Build in this order, which keeps the operator's webhook instinct as the destination and puts the
deletions first:

1. **Phase 0 deletions** that need no new code and unblock the mechanical cases today.
2. **Option C as the state machine's core**: one classifier, one event record format, one action
   table, scheduled by the dispatch tick (folding in AISDLC-823, 826, 828, 829 and the landing parts
   of 816).
3. **Option D by adding a fast path later** (webhook or an Actions-sourced sink, chosen after C is
   running), because by then the event directory and the idempotent ingest exist and the fast path is
   a producer of the same records.

Why: the 2026-10-11 and 2026-10-13 audits attribute the crawl to ownership, not notification
latency. Code PRs are green 9 to 14 minutes after the last push; a 5-minute reconciliation adds at
most 5. The hours were spent in states with no owner. A webhook alone would have delivered the
"PR is red" event to a machine that, today, has nothing to do with it.

**Counter-argument.** The operator's instinct has a strong form: an event that arrives in seconds
lets dispatch act while the executor's context is still warm and the base has not moved again,
which reduces the second and third rebase passes that dominate the hour-scale PRs. A poll that runs
every five minutes can still arrive just after another merge has changed the base, and on a busy
day (80 merges in 24 h) the base changes about every 18 minutes, so reaction time is a real
fraction of the churn window. Polling also fails in the one way the audit says is common: the thing
that triggers the poll (a tick, a planner message) is itself a manual step, so Option C's
reliability is only as good as its scheduler, and the scheduler is the unsolved part (AISDLC-823).
Finally, the hybrid risks becoming "poll forever, webhook never" because the fast path has no
failing test that forces it. If the operator weights latency and warm context higher than
operational simplicity, Option A or D from the start is the defensible choice; the recommended
order simply defers its cost until the state machine it would feed exists.

## Design Details

### Event record (common to all options)

```json
{
  "schemaVersion": "v1",
  "key": "ai-sdlc/ai-sdlc#1449@ab12cd3:check_suite.completed:2026-10-13T04:40:11Z",
  "source": "webhook | actions | poll",
  "pr": 1449,
  "headSha": "ab12cd3",
  "kind": "check_suite.completed",
  "observedAt": "2026-10-13T04:40:12Z"
}
```

An event is a hint to re-read the PR; the classifier reads state from GitHub, not from the payload.

### Board changes

New board state `landing/` (AISDLC-816 AC-2): a task moves from `inflight/` to `landing/` at PR
create and to `done/` only on `merged`. The state machine owns `landing/` entries. `requeue` and
`resume` become keyed on PR state (Open Questions 3 and 4 ask how).

### Persistence

Open Question 5 asks where state persists. Under every option the PR state is recomputable; what
persists is the per-PR record `{task, pr, lastState, lastAction, lastActionAt, owner, attempts by
shape}` used to avoid repeating an action and to detect a loop.

### Behavioral changes

- `success` from an executor means armed and green or explicitly "handed to the state machine"
  (Open Question 6).
- Fresh claims pause while an unlanded PR is red or unarmed (AISDLC-816 AC-3).
- The tick lists open task PRs with state, age and owner in its handoff (pile-up audit AC-11).

## Backward Compatibility

- Additive on the board: `landing/` is a new directory; consumers that read only `done/` keep
  working but see tasks later than before.
- Verdict semantics change (done means merged). Docs and `executor.md` change in lockstep.
- Existing environment: no new workflow or process is required for Option C. Options A, B and D add
  one.
- No schema change to RFC-0042 attestations. The state machine's mechanical re-sign uses the existing
  hook path.

## Alternatives Considered

The four options above are the alternatives. Two more were rejected before this draft:

- **A hosted control plane (a Cloudflare Worker or similar) that holds state.** Solves "laptop
  closed" fully, but introduces credentials and a service outside the repository, and class (c)
  decisions (accounts, money). Left to a later RFC if Option D proves insufficient.
- **Making the executor wait on its PR** (a long-lived executor that polls until merge). Retains one
  owner but holds a context window and a subscription slot for hours of pure waiting, contrary to
  "one task per context" and the auto-clear threshold.

## Implementation Plan (phased sketch)

Phase 0 and the later phases are a sketch for the operator; no tasks are filed by this RFC (scope
rule: filing follows operator authorization).

**Phase 0: delete first, no new code**
- Decide the status of the retry cap on PR follow-ups and "resume needs a claim" (Open Questions 3,
  4) and record it.
- Stop the planner survey as a PR watch; stop starting the ci-failure-watcher by hand.
- Remove the phrase test in `mark-ready` from the contract (state test only), or file the task.
- Remove executor-side status flips in the parent (check what AISDLC-825 already covers).
- Resolve the AISDLC-828 number collision (two task files carry that id).

**Phase 1: state machine core (Option C)**
- `pipeline-cli/src/hierarchy/pr-state.ts` classifier with hermetic tests; action table from
  AISDLC-823; event record writer; board `landing/` state; tick calls the classifier for each open
  roster PR; `requeue`/`resume` accept `--note` and PR-keyed preconditions.

**Phase 2: ownership and definition of done**
- DEC-0127 implemented (AISDLC-816 AC-1 to AC-6); handoff lists open PRs; fresh-claim pause.

**Phase 3: fast path (Option A, B or D), only if Open Question 1 chooses it**
- A receiver or workflow that writes the same event records; listener health selects the poll
  interval; chaos test: kill the listener, assert the reconciler produces the same state.

**Phase 4: fold or retire**
- Delete the ci-failure-watcher and `resolve-conflicts` command body (pointer only) per AISDLC-829;
  update `cli-hierarchy.md`, `operator-dispatch.md`, `executor.md`.

### Velocity impact

Positive by construction. Phase 0 removes steps; Phases 1 and 2 remove the planner round trip and the
unowned interval, targeting the p75 tail (356 min) and the 17 of 80 PRs over 12 h, not the 13 minute
CI path. Costs: Phase 3 adds an operator-run component (A) or a workflow (B) and must justify itself
against a measured reaction-time gain over Phase 1; the RFC proposes measuring median time from
"red or conflicting" to "action taken" before and after Phase 1 and deciding on Phase 3 from that
number.

## Open Questions

None of these is resolved here. Each lists options only; the operator answers through the decision
rubric (class (a), (b) or (c) per the Decision authority rules).

1. **Event source: webhook, poll, or hybrid?**
   - (a) Option C first, no fast path (poll only).
   - (b) Option C first, add a fast path later (the recommended order).
   - (c) Option A from the start (webhook with poll only as emergency catch-up).
   - (d) Option B (Actions as the source) with C as fallback.
   **Resolution (2026-10-14, full rubric): webhook first, poll as the fallback reconciler** (RFC
   Option A as the primary source, Option C as catch-up; the hybrid of Option D with the fast path
   mandatory in Phase 1 rather than deferred). Industry research: Argo CD and Flux keep the
   reconcile loop as truth and use webhooks only to shorten the interval; Mergify, Kodiak and Bors
   are webhook-driven hosted services; GitHub's local-receiver tooling (`gh webhook forward`, smee)
   drops on sleep. **Shipped substrate:** AISDLC-823 already landed the poll, but as prose (the
   dispatch model gathers PR facts over REST into `.pr-facts.json` every 15 min or less and calls
   `cli-dispatch classify-prs`); `ci-failure-watcher` (AISDLC-460) is a second 60 s `gh` poller; a
   reusable HMAC-validating receiver exists in `reference/src/adapters/webhook-server.ts` and
   `orchestrator/src/webhook-manager.ts` and is used by nothing in dispatch. **Refinement:** the
   webhook receiver is the Phase 1 producer of event records; the 823 poll is re-implemented in code
   (classifier plus a deterministic scheduler, not a model session) as the reconciler that runs on
   wake and on a timer, and must produce the same state the events would have; `ci-failure-watcher`
   is deleted as a duplicate poller. **Counter-argument:** "a laptop receiver needs a tunnel and a
   secret, loses events while asleep, and the audits blame ownerless states, not notification
   latency." Rebuttal (operator): latency and a warm executor context are weighted above
   operational simplicity; on an 80-merge day the base moves every 18 min, so a poll interval is a
   real fraction of the churn window and costs second and third rebases; sleep loss is covered by
   the reconciler. **Selected over poll-first-fast-path-later** because a deferred fast path has no
   forcing function and risks "poll forever"; **over Actions-as-source** because the runner queue
   (64 s median) makes it no faster than a poll. Consequence: OQ-10 (receiver trust) is in scope.
2. **Who owns the PR after the draft is created?**
   - (a) The executor that made it, until merged (long-lived context).
   - (b) A "landing" role (a new roster entry) that owns every unlanded PR.
   - (c) Dispatch's state machine, with the executor re-entered by resume only for real red.
   - (d) Mixed by state (the ownership table in the Proposal).
   **Resolution (2026-10-14, full rubric): mixed by stage, with the executor owning the PR until it
   is READY and the dispatch state machine owning it from ready to merged.** Operator's statement
   of the executor lifecycle: do the work with the developer, push the branch as a draft PR, run the
   reviewer round, sign the attestation once the reviews finish, push the envelope, and flip the PR
   from draft to ready so CI can run. The dispatched task is owned by that executor until the flip
   to ready, unless the executor dies or times out (AISDLC-826 thresholds); then the dispatch state
   machine takes over and continues the attestation work itself (resume on the same branch, not a
   fresh executor claim by default). From ready onward the state machine owns the PR: CI
   observation, rebase on skew, re-sign via the hook, retrigger on flake, arm, and done on merge;
   a real red on the current head re-enters an executor by resume carrying the failing check line
   and head SHA (the Proposal's ownership table applies from "ready" on). Industry research:
   Mergify, Kodiak, Bors and Prow/Tide hand the PR to the bot after approval and pull the author
   back only for a real failure; the operator's split puts that hand-over at "ready" rather than at
   "draft". **Shipped substrate:** AISDLC-823's action table already implements the post-ready
   half (mechanical states get machine actions, only real failure resumes the executor); AISDLC-826
   implements the death/timeout hand-over; AISDLC-816 (DEC-0127, unshipped) must be read with this
   split: an executor is free to claim once its PR is ready, not once it is merged.
   **Gap surfaced:** planner filing PRs (docs, task files, decision sync) have been opened as
   drafts by the planner and left with no owner; under this split they have no executor stage at
   all and fall straight to the state machine, which today ignores PRs without a task id. OQ-11
   decides the mechanism; the requirement recorded here is that every PR has an owner from the
   moment it exists. **Counter-argument:** "freeing the slot at draft PR (machine owns from draft)
   would raise throughput by the length of the review round." Rebuttal (operator): the review
   round and the signing are the executor's work product, done in its worktree with its key; a
   half-attested PR has no meaning to the machine. **Selected over originating-executor-until-
   merged** because CI waits and rebases are not executor work; **over a landing roster role**
   because the post-ready stages are mechanical and belong to the deterministic machine, not a
   model session.
3. **Is the retry cap deleted or scoped?**
   - (a) Deleted for PR follow-ups only (AISDLC-828); stays for PR-less failures.
   - (b) Replaced by a per-shape loop guard (same classified failure N times).
   - (c) Deleted entirely; the loop guard is the stall detector.
   - (d) Kept as is; only `resume` is widened.
   **Resolution (2026-10-14, full rubric): the count cap stays for PR-less failures; PR
   follow-ups get a same-head loop guard instead of a count.** Industry research: Kubernetes
   controllers use per-key backoff with a rate limiter rather than a retry count; Prow/Tide retests
   with backoff and gives up only on a repeated identical failure; Mergify has a per-rule retry
   maximum. **Shipped substrate:** the RFC's option (a) is already live as AISDLC-847 (the text
   above says AISDLC-828; the retry-cap change was renumbered to 847 and 828 is the five-step DoR
   gate deletion): `dispatch/requeue.ts` bypasses the cap when the failed task has an open PR, and
   AISDLC-857 extends the check to `prNumber`. That bypass is unbounded. **Refinement:** the state
   machine records `(state, action, headSha)` for every action it takes on a PR; when it is about
   to take the same action on the same head SHA a second time (rebase and still DIRTY, retrigger and
   still cancelled, re-sign and still a content-hash mismatch), it parks the PR to the planner with
   the pair as the note instead of acting. Unlike failures never add up and a new head resets the
   guard. **Counter-argument:** "the guard depends on a stable classifier; if skew and real red
   flap, no two pairs match and the loop continues." Rebuttal: the key is the head SHA, not the
   classification; two actions with no new head between them mean the action did not change the
   code, which is the loop signature whatever the state was called. **Selected over keeping 847
   as shipped** because an unbounded mechanical loop costs a reviewer round per pass; **over
   deleting the cap in favour of the stall detector** because AISDLC-826 sees only silent
   workers and a worker that fails loudly every time never stalls.
4. **Is "resume needs a claim" kept?**
   - (a) Keep; add `requeue --note`.
   - (b) Delete; a note can be attached to a `failed/` or `landing/` task.
   - (c) Replace both with one `reenter` command keyed on PR state.
   **Resolution (2026-10-14, full rubric): split by PR kind. Docs-only PRs re-enter by
   `cli-file rebase` performed in place (lease push on the same branch, no replacement PR); task
   PRs re-enter by one `reenter` command keyed on PR state that runs the machine action or writes
   a queue manifest carrying note, branch and head SHA, creating the claim as its side effect.**
   The claim stops being a precondition of re-entry and becomes an output of it. Operator framing:
   the volume behind the "resume cannot reach the branch" escalation class (DEC-0111 to DEC-0122
   in one night) was planner filing PRs (task files, decision records, RFC edits, operations
   docs) pushed through the task-PR shape: draft, reviewer round, claim, resume. None of those
   stages has meaning for a docs change, so the fix is to delete them for that kind rather than
   to make resume reach them. **Shipped substrate (survey 2026-10-14):** `cli-file --pr` already
   opens ready (not draft) from a fast-forward of `origin/main` (`pipeline-cli/src/cli/file.ts`);
   `auto-enable-auto-merge.yml` arms any non-draft same-repo PR on `opened`; the gate's docs-only
   detector (`scripts/is-docs-only-changeset.mjs`) skips build-test, integration, attestation and
   independence; `check-pr-governance.mjs` requires no reviewers for docs-only; branch protection
   needs only `Backlog Drift` and `ai-sdlc/pr-ready` with zero approvals; DEC-0088 grants the
   planner lease pushes on `ai-sdlc/file-*`. The lane exists; the stalls are four gaps: (1)
   `dor-readiness-gate` fails a task file whose reference is a sibling task in another open
   filing PR and nothing re-runs it when that PR lands (#1524 is the live case); (2) `cli-file
   rebase` opens a replacement PR and closes the old one, a closed-unmerged PR per base move; (3)
   PRs opened `--draft` by the planner or a skill (decisions-sync #1525, RFC walkthrough PRs) skip
   both the gate and the arming and sit ownerless; (4) `lint` runs unconditionally on a one-file
   `.md` diff and `cli-merge-if-eligible` has no `docs` source kind. **Refinement (Phase 0 of
   this RFC, deletions first):** no-task PRs are never opened as drafts; `lint` leaves the
   docs-only job set (prettier on markdown runs inside the drift job without an install);
   `cli-file rebase` rebases in place under DEC-0088; a DoR reference to a task present in
   another open `ai-sdlc/file-*` PR is `pending` rather than `fail` and the machine re-runs the
   gate when that PR merges; `--source-kind docs` is added to `cli-merge-if-eligible`; the docs-only
   path list gains `.ai-sdlc/dispatch/briefs/` and `.claude/memory/`, and its four copies (gate
   detector, `verify-attestation.yml` paths-ignore, `review-scope-core.mjs`, `pr-unstick.ts`;
   AISDLC-534.1 is consolidating them) collapse to one. Industry research: Prow/Tide and Mergify
   re-enter a PR by PR number and allocate the worker from the action; Temporal re-enters a
   workflow by id with the worker as a leased detail. **Counter-argument:** "AISDLC-762.1 and 807
   just wired resume through the claim path; `requeue --note` is nearly free and `reenter` is new
   surface in a stability week." Rebuttal: those fixes patched symptoms of the coupling and the
   class recurred after each; removing the docs volume from the task shape and keying task
   re-entry on the PR removes the root and deletes two commands. **Selected over keeping the
   claim-bound resume** for that reason; **over attaching notes to board records without a
   claim** because the branch lease is the one safety property worth keeping.
5. **Is "done" only "merged"?**
   - (a) Yes, a single definition (DEC-0127 as written).
   - (b) Two named states: `landed` (merged) for the board and `delivered` (armed and green) for the
     executor's verdict.
   - (c) Keep the status quo definition for planner filing PRs (no task, no executor), "merged" for
     task PRs.
   **Resolution (2026-10-14, full rubric): two named states.** `delivered` means the PR is ready
   and auto-merge is armed; it is the executor's verdict outcome and it frees the executor slot
   (the OQ-2 hand-over point). `landed` means merged; it is the only event that writes `done/`,
   syncs the parent and releases dependants (the effect DEC-0127 asked for). The task file still
   moves to `backlog/completed/` in the PR's own diff. Industry research: Prow/Tide separates "in
   the merge pool" from "merged"; deployment pipelines separate "approved" from "deployed";
   states with different owners and failure modes are not collapsed into one word. **Shipped
   substrate:** today `done/` receives a verdict when the executor returns `success` with a
   `prUrl`, which is "done at draft PR", the definition that left PRs ownerless in the 2026-10-11
   pile-up; AISDLC-823's `merged` state already maps to `mark-done-sync-parent-start-next`, so the
   landed action exists in code and only the writer rule changes. **Refinement:** `delivered`
   is a verdict outcome value, not a board directory; `done/` has a single writer (the state
   machine, on merge); the brief-progress loop and `cli-dispatch peek` read only `done/`.
   AISDLC-816 is to be read as: no new claim while this executor has an undelivered PR, not an
   unlanded one. **Counter-argument:** "two words invite drift; a dashboard counts delivered as
   finished and the pile-up returns under a new name." Rebuttal: drift would require a second
   writer of `done/`, which is a reviewable code change, and the board exposes no directory for
   delivered. **Selected over a single done = merged** because the executor cannot author a
   verdict for a PR it no longer owns after ready; **over the status quo** because that is the
   failure being fixed.
6. **Where does the state machine persist?**
   - (a) Board files (`landing/`, per-PR record) with GitHub as the recompute source.
   - (b) GitHub itself (labels, check runs) read by the tick.
   - (c) The decisions `events.jsonl` style append-only log.
   - (d) A combination: board for ownership, GitHub for facts.
   **Resolution (2026-10-14, full rubric): board for ownership and history, GitHub for facts.**
   A per-PR record `landing/<pr>.json` holds the owner (OQ-2), the `(state, action, headSha)`
   history the loop guard needs (OQ-3) and the delivered and landed timestamps (OQ-5); the
   `events/` directory holds raw ingest as the common section requires; PR facts (checks,
   mergeStateStatus, draft, merged, auto-merge) are re-read from GitHub on every classification
   and are never cached as truth. The existing `_orchestrator/events-*.jsonl` log remains the
   audit trail (AISDLC-823 already writes `DispatchPrClassified` there). Mirroring the owner as a
   PR label is an optional, additive later step for UI visibility and does not move the source of
   truth. Industry research: Tide recomputes its pool from the GitHub API every sync and writes
   nothing to GitHub but the merge; Mergify keeps queue state server-side and mirrors a summary as
   a check run; Kubernetes keeps desired state in its own store and treats the live system as the
   fact source. **Shipped substrate:** the board already uses per-task sidecar JSON under
   `queue/ inflight/ done/ failed/ blocked/`; `landing/` is a new sibling in the same idiom; 823
   has no per-PR record today. **Counter-argument:** "board files live on one laptop; a second
   machine or the operator in the GitHub UI cannot see ownership." Rebuttal: the deployment is
   one laptop by design (signing key and worktrees are local; remote agents are read-only per
   AISDLC-442); facts are on GitHub regardless, so a second reader recomputes state minus
   ownership, and the label mirror covers the UI case. **Selected over GitHub-only** because
   mutable labels as the only copy of ownership break the recomputable guarantee; **over an
   append-only log only** because the audit log already exists and replaying it to answer "who
   owns this PR" is the wrong shape for a tick.
7. **Do the pipeline's push, ready and arm steps move into the state machine?**
   - (a) No; Step 11 stays, the machine starts at "draft PR exists".
   - (b) Ready and arm move (the machine flips and arms); push stays with the executor.
   - (c) All of Step 11 and the pre-push re-sign path move to a deterministic runner the machine calls.
   **Resolution (2026-10-14, full rubric): Step 11 stays with the executor through the ready
   flip; the mechanical landing path is extracted into one deterministic runner that both Step 11
   and the state machine call.** The runner (working name `land-prep <pr>`) does: rebase onto
   `origin/main`, drop a stale envelope, lease push so the pre-push hook re-signs, and a guarded
   flip to ready whose precondition (CodeQL clean, verdict approved by state, not by phrase) is
   code in the runner whoever invokes it. Step 11 calls it before the first push when the base is
   stale and at the end of the executor's round for the flip; the state machine calls it for
   post-ready skew (red(skew), DIRTY, BEHIND) and when it takes over a dead executor's PR after
   signing. Arming stays with `auto-enable-auto-merge.yml` on `ready_for_review`; the machine arms
   through `cli-merge-if-eligible --arm` only when that was missed. Industry research: Bors, Tide
   and Mergify push to an author's branch only to update it; the author marks ready; the bot owns
   the mechanical updates and the merge. **Shipped substrate:** Step 11 is TypeScript in
   `pipeline-cli` (push, `gh pr create --draft`, flip); re-sign on rebase lives in the pre-push
   hook chain (`check-attestation-sign.sh`) and fires on any push from a worktree; the 2026-10-11
   handoff shows the machine-side gap as a repeated hand path ("rebase + heartbeat + lease push,
   hook re-signs; REST flip") because no CLI wraps it. **Counter-argument:** "the machine
   flipping is safer because it checks CodeQL and the verdict by state rather than trusting the
   executor's own round." Rebuttal: the check is code in the runner; the caller does not change
   what is checked, and an executor flipping through the same guarded runner avoids a draft
   window waiting on the next event. **Selected over moving ready and arm to the machine**
   because that re-introduces an ownerless window between sign and flip, against OQ-2; **over
   moving all of Step 11** because the push, and with it the hook chain, belongs to whoever holds
   the worktree.
8. **Local runner or CI-side runner for the state machine?**
   - (a) Local only (signing key, worktrees and plugin are local; remote agents are read-only by design).
   - (b) CI-side classification, local actions.
   - (c) CI-side for non-signing actions (ready flip, retrigger), local for the rest.
   **Resolution (2026-10-14, full rubric): local only.** Receiver (OQ-1), classifier, board
   records (OQ-6) and the `land-prep` runner (OQ-7) all run in `pipeline-cli` on the operator's
   machine, where the signing key, the worktrees and the plugin are; remote agents stay read-only
   (AISDLC-442). Laptop closed means nothing happens, and the reconciler catches up on wake. A
   self-contained `rerun-on-cancel` workflow (re-run a cancelled or infra-failed gate run while
   the laptop is closed) may be added later as an additive step, with `actions: write` scoped to
   that job, only if measured overnight dwell justifies it; it would not move any part of the
   machine. Industry research: Tide, Bors and Mergify run as a controller or service outside CI;
   CI produces check results and the controller decides; none runs the decision loop inside the
   job whose rollup it is waiting for. **Shipped substrate:** everything AISDLC-823, 826 and 847
   shipped is local `pipeline-cli` code; no workflow writes to the board; a retrigger is one REST
   call. **Counter-argument:** "a flaky run cancelled at midnight sits for eight hours; a small
   workflow could re-run it so the PR is green at wake." Rebuttal: that is the one honest CI-side
   gain and it is the additive step named above; a CI-side rebase is not a gain because it
   produces an unsigned head the attestation gate rejects. **Selected over CI-side
   classification** because a classifier without the board (ownership, loop-guard history) is a
   different and weaker classifier maintained twice; **over CI-side flip and retrigger** because
   the flip is the executor's under OQ-7, leaving one action row for the cost of a second runtime
   and a write-permission workflow.
9. **How do AISDLC-816, 823, 826, 828, 829 fold in?**
   - (a) All superseded by this RFC's phases and re-filed against it.
   - (b) 816 stays (it is DEC-0127 as written); 823, 826, 828, 829 are phases of this RFC.
   - (c) All proceed as filed; this RFC only adds the fast path (Option A, B or D).
   - (d) Sequence them, with this RFC deciding only the event source.
10. **What does the receiver trust, if Option A or D is chosen?** (Only relevant to 1(c)/(d).)
    - (a) Nothing in the payload; an event is a trigger to re-read through authenticated REST.
    - (b) The payload for non-mutating state only; mutating actions re-read.
    - (c) Full payload (not recommended; listed for completeness).
11. **Planner filing PRs and other no-task PRs (release, decision-sync).**
    - (a) Out of scope: reported to the planner, not owned.
    - (b) Owned by the same machine with a no-task action set (arm only).
    - (c) Owned by a separate small machine.
    **Resolution (2026-10-14, full rubric, decided with OQ-4): owned by the same state machine
    with a docs action set.** A no-task PR (planner filing of task files, decision records and
    decision-log sync, RFC edits and walkthroughs, operations docs, briefs, memory files) has no
    executor stage; it is owned by the state machine from the moment it exists, which is the
    requirement OQ-2 recorded (every PR has an owner from birth). Its action set is small and
    deterministic: `rebase-in-place` on DIRTY or BEHIND (`cli-file rebase` under DEC-0088),
    `rerun-dor` when a sibling filing PR it references merges, `arm` through `cli-merge-if-eligible
    --source-kind docs` when auto-enable missed it, and `route-to-planner` only for a real check
    failure (drift error, DoR gate 1 or 2, governance marker scan). The release-please PR stays
    operator-only (class (c)); the machine reports it and never arms it. A docs PR needs no
    backlog task: the PR is the work. **Shipped substrate** and the four gaps are listed under
    OQ-4. **Counter-argument:** "a separate small machine keeps the task-PR classifier simple and
    lets the docs lane ship first." Rebuttal: the docs action set is three rows of the same table
    keyed on the same PR facts; a second machine is a second scheduler, a second event ingest and
    a second owner column for no gain. **Selected over out-of-scope** because ownerless filing
    PRs were the main source of the 2026-10-11 escalation storm; **over a separate machine** for
    the reason above.

12. **What does "JEV" mean for the ladder's rung 2?**
    - (a) Exactly the RFC-0049 judgment layer with Jev as the provider.
    - (b) Any provider behind the RFC-0049 typed-question interface, selected by config.
    - (c) A separate cheap classifier outside the judgment layer.
13. **Where is the ladder enforced?**
    - (a) A lint over agent and command frontmatter requiring a declared rung, input schema, output schema and bounds.
    - (b) A reviewer-gate check on PRs that add a prose automation.
    - (c) Convention only, recorded in this RFC and CLAUDE.md.
    - (d) The dark-code style static scan extended to flag undeclared model calls.
14. **Is there a development trio for rung 4, and what is the budget per rung?**
    - (a) Reuse the current developer role as the cheap executor, with a new planner and synthesizer step around it.
    - (b) A new planner, executor, synthesizer trio for development, parallel to the review trio.
    - (c) Keep the executor developer round as is; apply the ladder to everything else.
    - Budget: (i) a per-state-dwell call cap per rung, (ii) a per-PR token budget where rung-4 spend needs a logged rung-3 failure, (iii) report only, no cap, in v1.

## References

- `docs/audits/2026-10-13-cicd-five-step-audit.md` (F1, F4, section 1 numbers)
- `docs/audits/2026-10-11-pr-pileup-dispatch-role-audit.md` (Findings 1 to 6, AC-7 to AC-13)
- `docs/operations/cli-hierarchy.md`, `ai-sdlc-plugin/commands/{operator-dispatch,executor,planner}.md`
- RFC-0041 Conductor / Worker Process Architecture (Dispatch Board)
- RFC-0051 Session Hierarchy for Parallel Dispatch
- RFC-0042 Proof-of-Execution Attestation (head-binding)
- RFC-0012 Pipeline CLI (Step 0 to 13), RFC-0035 Decision Catalog
- DEC-0127 (definition of done is a PR on main), DEC-0090 (five-step algorithm)
- Backlog: AISDLC-816, 823, 826, 828 (two files share this id), 829
- Code: `pipeline-cli/src/dispatch/{board,requeue,resume,session-reaper}.ts`,
  `pipeline-cli/src/hierarchy/{dispatch-loop,mark-ready,playbook,stall}.ts`,
  `pipeline-cli/src/runtime/ci-failure-watcher.ts`, `pipeline-cli/src/steps/11-late-rebase.ts`
- Workflows: `.github/workflows/{ai-sdlc-gate,ai-sdlc-fix-ci,main-health-monitor,release}.yml` and the
  `auto-enable-auto-merge.yml` workflow
