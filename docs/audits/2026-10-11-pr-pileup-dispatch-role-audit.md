# Audit: the 2026-10-11 pull-request pile-up and the dispatch role

**Date:** 2026-10-11 · **Author:** planner session, on operator instruction (Dominique) · **Status:** findings and rule changes; implementation in AISDLC-816 (amended by this audit) and AISDLC-815.

## 1. What happened

At 17:50Z on 2026-10-11 the repository had 32 open pull requests (33 counting the release PR). In the 24 hours before, 80 PRs had merged (56 code, 24 filing), so throughput was not the problem: the open list did not shrink because PRs that were opened were not landed.

Board state of the 32 at the time of the survey:

| Board state of the task | PRs | Meaning |
|---|---|---|
| `done/` (executor reported `success`) | 17 | the pipeline counted the task finished at PR open; nobody owned the PR afterwards |
| `failed/` (blocked at re-entry, draft never flipped, or real red) | 11 | parked, waiting on a resume that needed a planner ruling |
| no task (release PR, decision-sync draft, record PRs) | 4 | operator or auto-enable |

Median age 19 h; four over 24 h; two over 110 h (#1248 AISDLC-742, #1243 AISDLC-719). Of the 17 `done/` PRs, 11 were red on `ai-sdlc/pr-ready` for one mechanical reason: the attestation envelope's subject was orphaned by a rebase (the class AISDLC-810 fixed on 2026-10-11 07:15Z), and the remaining ones were stale Build & Test runs from the period main was red (AISDLC-534 lockstep test, 01:10Z–01:33Z). Six drafts (#1402–#1407) opened through the hand path were never flipped to ready because their body lacks the phrase `mark-ready` looks for, so their checks never ran.

## 2. What the dispatch role was told to do

The operator's premise: it is the dispatch session's role to follow up on PRs until they land. The audit checked the role's instructions and code for that requirement.

- `ai-sdlc-plugin/commands/operator-dispatch.md` (the role's whole loop): the words "pull request" occur in hard rule 3 (never merge or close one), in the `markReady` paragraph (flip a draft after CodeQL; send a red finished PR back with `cli-dispatch resume`), and nowhere else. There is no step that lists open PRs, no step that arms a green PR, no step that checks whether a `done/` task's PR landed.
- `pipeline-cli/src/hierarchy/dispatch-loop.ts` (`cli-hierarchy tick`): the tick does four things — ingest briefs, watch new verdicts (clear the executor, run the playbook **on failures only**), emit reports, and `markReadyAfterCodeql`. The playbook (`playbook.ts`) acts only on a failure record with a recognised cause code (`rebase-push`, `retrigger-ci`, `requeue`); a `success` verdict triggers nothing.
- `mark-ready.ts` flips only drafts whose body says "draft until CodeQL is clean". Drafts opened any other way are reported as `skipped` "for the operator to close".
- `handoff.ts` (what a dispatch context reads after every self-clear): roster, board, inflight tasks, open decisions. **No open-PR list.** Because dispatch self-clears after every tick (Step 5), each wake-up starts with no memory of PRs beyond what the board says, and the board stops at `done/`.
- `.ai-sdlc/agent-role.yaml` operational grants: rebase, lease push, retrigger CI, requeue, sub-id follow-ups, operational decisions, clear executor, mark-ready-after-codeql. There is no grant to arm an eligible PR, so even a green PR waits for the auto-enable workflow (which only fires on `opened`/`reopened`/`ready_for_review` since AISDLC-799's design, and had a 150-run queue behind it on 2026-10-10).
- `executor.md` Step 3–5: `success` lands in `done/` at PR open; "Dispatch clears this context on the verdict". The executor that knows the PR is gone the moment the PR exists.
- `docs/operations/cli-hierarchy.md` §"Sending a finished task back (resume)": describes the resume command for a `done/` task whose PR "later goes red" — the trigger is a person or the planner noticing.

**Finding 1 (requirement).** The requirement "the dispatch session follows a PR until it lands" was never written into the role, the tick or the grants. The role was not violated; the requirement was missing. The only PR watch in the system was the planner's 30-minute survey tick, which depends on the planner being present, un-cleared and not busy with design work; it stopped at 04:25Z on 2026-10-11 and the list grew from 24 to 32 while dispatch ran correctly by its own instructions.

**Finding 2 (definition of done).** Three definitions coexisted: executor `success` = PR open; board `done/` = verdict written; CLAUDE.md "Done semantics" = task file moved to `backlog/completed/` in the PR. None of them is "on main". Every actor could be correct and the PR could still rot.

**Finding 3 (hand-off at the fragile moment).** A PR is most likely to go red *after* it is opened: the next merge to main changes the base, the attestation subject is orphaned by any rebase, CI on main can be red for an unrelated reason. The design hands the PR off exactly then, to nobody.

**Finding 4 (mark-ready is a phrase match).** Readiness depends on a sentence in the PR body. The hand path, REST-opened PRs and resumed PRs do not carry it, so their checks never run and they sit as `skipped` for the operator — the operator was never told.

**Finding 5 (no landing memory).** With no PR list in the dispatch handoff and a self-clear per tick, dispatch cannot notice that the same PR has been red for 18 hours. The planner's survey had that memory; dispatch did not.

**Finding 6 (planner as the only PR owner is a single point of failure).** Every red PR needed a planner ruling to get a resume note, because `requeue` carries no note and `resume` only works on `done/`. Ten of the eleven resumes this afternoon were the same ruling (rebase, drop the stale envelope, let the hook re-sign). A rule that is applied identically ten times is not a decision; it is a missing playbook step.

## 3. Five-step review (requirements first)

1. **Requirement questioned.** "A task is done when its PR is open" — set by the Step 11 hand-back design (RFC-0012) and carried into RFC-0051's executor loop. It was right when merges were human and PR CI was fast. It is wrong under autonomous drain: nothing downstream owns the PR. Replaced by DEC-0127 (operator, 2026-10-11): done = PR on main.
2. **Delete.** The hand-back at PR open (executor `success` for an open PR). The phrase match in mark-ready. The planner survey as the PR watch.
3. **Simplify.** One owner per PR at every moment: the executor until the PR is armed and green; dispatch's tick from then until it lands or goes red; back to the same executor by resume if it goes red. One definition of done for executor verdict, board and docs. One landing playbook step for the mechanical red shapes (stale attestation subject, stale Build & Test on a now-green main, superseded/cancelled check) that dispatch applies without a planner ruling.
4. **Accelerate.** Arm on green from the tick, do not wait for a workflow event. Flip every draft whose CodeQL is clean, whatever the body says.
5. **Automate.** The board refuses a fresh claim while a PR-bearing task is unlanded (unless the new task names the PR it fixes). The dispatch handoff lists open PRs with age, state and owner, so a cleared context inherits the landing work.

Velocity impact: positive. The 32-PR drain cost a full day of one executor plus planner time; with the rules below the same PRs would have landed on the tick after they went green or been resumed on the tick after they went red.

## 4. Rule changes (applied to AISDLC-816; new ACs in bold)

AISDLC-816 (filed 2026-10-11, DEC-0127) already carries: `success` requires armed + green (AC-1), `done/` only when merged with a `landing/` state in between (AC-2), fresh claims refused while a landing PR is red/unarmed (AC-3), dispatch flips and arms on every tick (AC-4), status shows the PR per executor (AC-5), docs (AC-6). This audit adds:

- **AC-7: Landing watch in the tick.** `cli-hierarchy tick` lists every open PR whose task is on the board (`landing/`, `done/`, `failed/`) with `ai-sdlc/pr-ready` state, `mergeStateStatus`, draft flag and age; arms eligible ones through `cli-merge-if-eligible --arm`; sends red ones back with `cli-dispatch resume --note` carrying the mechanical playbook note; reports any PR older than 6 h to the planner by name.
- **AC-8: Landing playbook.** The playbook gains cause codes for the three mechanical red shapes seen in this drain — `stale-attestation-subject` (rebase, `git rm` the envelope, lease push so the hook re-signs; no reviewer round), `stale-build-on-red-main` (retrigger when main-health is green again), `superseded-check-cancelled` (wait for the rerun on the current head, retrigger only if none is running) — and applies them under the existing grants without a decision record. Any other red shape escalates with the failing check name.
- **AC-9: Mark-ready by state, not by phrase.** A draft is flipped when its CodeQL checks are clean and its PR is not superseded, regardless of the body text. The `skipped` list goes to the planner, not "the operator".
- **AC-10: Operational grant `arm-eligible-pr`** added to `.ai-sdlc/agent-role.yaml` for the dispatch role; the tick uses it. (A tightening of who may arm, not a loosening: the path remains `cli-merge-if-eligible`.)
- **AC-11: Handoff carries the PR list.** `handoff.ts` adds an "Open pull requests" section (number, task, state, age, owner, last action) for the dispatch and planner roles, so a self-cleared context inherits the landing work.
- **AC-12: `requeue --note`.** `cli-dispatch requeue` accepts the same `--note` as `resume`, so a `failed/` task can be re-entered with instructions without a planner PR comment.
- **AC-13: Role text.** `operator-dispatch.md` gains a "Step 2b — Landing" paragraph stating the owner-at-every-moment rule and the three playbook shapes; `executor.md` Step 3 states that `success` means armed and green, and that a red PR returns to this executor by resume before any fresh claim.

Related: AISDLC-815 (clear on a threshold, not per tick — keeps the landing memory in context), AISDLC-807 (resume accepts `iterate-needed`/`failed`), AISDLC-762.2 (resume reads the PR's branch), AISDLC-810 (hook re-signs on an orphaned subject).

## 5. What the operator should expect after the change

- Open PR count on a healthy day: at most the number of executors plus the PRs on CI at that moment.
- A red PR is resumed by the executor that made it on the next tick, with the playbook note, without a planner message, unless the red shape is new.
- The planner sees a PR by name only when it is older than 6 h or its red shape is unrecognised.
- The dispatch handoff shows every open PR; `cli-hierarchy status` shows which executor is landing which PR.

## 6. Evidence

- Survey script and output: planner session scratchpad, 2026-10-11 17:50Z and 20:00Z (`gh api pulls`, `commits/<sha>/check-runs`, board directories).
- Role and code read: `ai-sdlc-plugin/commands/operator-dispatch.md`, `ai-sdlc-plugin/commands/executor.md`, `pipeline-cli/src/hierarchy/{dispatch-loop,playbook,mark-ready,handoff,operational}.ts`, `.ai-sdlc/agent-role.yaml`, `docs/operations/cli-hierarchy.md`.
- Related decisions: DEC-0127 (done = landed), DEC-0089/DEC-0101 (one required context), DEC-0096 (one attestation poster), DEC-0102 (one pre-push chain).

## Amendments from the 2026-10-11 audit (to apply when #1415 lands)

Append after the existing AC-6 in the "## Acceptance Criteria" section of AISDLC-816, and add to its `## Notes`: `Audit: docs/audits/2026-10-11-pr-pileup-dispatch-role-audit.md (operator-ordered, 2026-10-11).`

- [ ] AC-7: Landing watch in `cli-hierarchy tick`: lists every open PR whose task is on the board (`landing/`, `done/`, `failed/`) with `ai-sdlc/pr-ready` state, mergeStateStatus, draft flag and age; arms eligible ones through `cli-merge-if-eligible --arm`; sends red ones back with `cli-dispatch resume --note` carrying the playbook note; reports any PR older than 6 h to the planner by name.
- [ ] AC-8: Landing playbook: cause codes `stale-attestation-subject` (rebase, `git rm` the envelope, lease push so the hook re-signs, no reviewer round), `stale-build-on-red-main` (retrigger once main-health is green), `superseded-check-cancelled` (wait for the rerun on the current head, retrigger only if none runs), applied under existing grants with no decision record; any other red shape escalates with the failing check name.
- [ ] AC-9: Mark-ready by state, not by body phrase: a draft is flipped when its CodeQL checks are clean and it is not superseded; the `skipped` list goes to the planner.
- [ ] AC-10: Operational grant `arm-eligible-pr` for the dispatch role in `.ai-sdlc/agent-role.yaml`, used by the tick; the path stays `cli-merge-if-eligible`.
- [ ] AC-11: The dispatch and planner handoff (`handoff.ts`) carry an "Open pull requests" section (number, task, state, age, owner, last action).
- [ ] AC-12: `cli-dispatch requeue` accepts `--note` like `resume`.
- [ ] AC-13: `operator-dispatch.md` gains a "Step 2b — Landing" paragraph (owner-at-every-moment rule, the three playbook shapes); `executor.md` Step 3 states `success` = armed and green and that a red PR returns to the same executor by resume before any fresh claim.
