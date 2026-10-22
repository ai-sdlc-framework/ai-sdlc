---
id: RFC-0058
title: Session Hierarchy on the Claude Code Mods API (retire the tmux keystroke layer)
status: Draft
lifecycle: Draft
author: 'Dominique Legault'
created: 2026-10-22
updated: 2026-10-22
requires: []
assumes: [RFC-0041, RFC-0042, RFC-0051, RFC-0054, RFC-0056]
requiresDocs:
  - operator-runbook
deferredDocs: true
deferredDocsDeadline: 2026-12-31
targetSpecVersion: v1alpha1
---

# RFC-0058: Session Hierarchy on the Claude Code Mods API

**Status:** Draft, v0.1 (2026-10-22). Six Open Questions, none resolved. Authored from
the ai-sdlc-io planner's report of 2026-10-22 ("replace the tmux session hierarchy
with a Claude Code Mod"), written at the operator's request.

**Lifecycle:** Draft
**Author:** Dominique Legault
**Created:** 2026-10-22
**Updated:** 2026-10-22
**Target Spec Version:** v1alpha1

## Summary

The RFC-0051 session hierarchy (planner, operator-dispatch, executors) steers Claude
Code sessions by typing into tmux panes: it detects "idle" by diffing pane text, sends
`/clear` and a resume command as keystrokes, proves who issued a start with a file token
and a pid walk, and parses the transcript from a Stop hook to decide when to clear.
Claude Code now ships a Mods API (build 2.1.304 on the operator's machine): a hooks
module loaded inside an interactive session that exposes, as typed calls and events,
most of what the hierarchy fakes with screen scraping. A mod runs inside the
interactive session, so the Max-subscription billing property that made sessions the
unit of execution (RFC-0041 §4.1, RFC-0051 Non-Goals) is kept.

This RFC moves the control plane of the hierarchy into one `hierarchy` hooks module of
the ai-sdlc plugin and deletes the keystroke layer. The board on disk, the briefs, the
decision catalog and the `cli-dispatch` / `cli-hierarchy` commands stay as they are.
Sessions are woken by `$.prompt.submit`, cleared or compacted by `$.command.run` /
`$.session.compact`, rotated by `session.measure`, and observed by `turn.start` /
`turn.complete`; board events travel by `$.session.send` and are consumed by a
`session.receive` hook before the model sees them, so a status relay costs no model
turn. Sender checks shrink, by design, to a mistake guard: the Mods origin field is
self-asserted, and authority stays where RFC-0051 and the decision catalog already put
it, on the board and in decision records on `main`.

## Motivation

### The keystroke layer and what it costs

1. **The resume is unreliable.** `pipeline-cli/src/hierarchy/clear.ts:420-484` runs a
   detached shell script that compares pane text, greps for "esc to interrupt", then
   sends `C-u`, `/clear`, Enter and the resume command. A swallowed Enter leaves the
   command typed but unsubmitted (AISDLC-1029). The adopter repo's auto-clear log holds
   359 entries from 2026-10-15 to 2026-10-22; 346 say "did not come back" (326 of them
   dispatch) and 9 say the pane never went idle. Some are detection misses rather than
   failures; either way there is no reliable signal.
2. **Identity is faked.** Starts typed through tmux carry no message envelope, so
   `executor-start` proves its caller with a file token written by the clear
   (`start-token.ts`, AISDLC-1028) and a pid walk (`caller-identity.ts`, documented as
   "a mistake guard, not authentication"). The 0.29.0 executor once passed its own
   `$PPID` and refused its own dispatch session. The token is single-use while the
   executor's idle loop re-issues the start (AISDLC-1032).
3. **Waiting costs processes.** `executor-start --wait 1500` runs in the background to
   get past the 600 s Bash foreground cap (`ai-sdlc-plugin/commands/executor.md:66`);
   dispatch sleeps between ticks with `cli-dispatch idle-backoff`; an enqueued task
   wakes idle executors through the clear path (AISDLC-738).
4. **Rotation is guessed.** A Stop hook reads token usage from the transcript and
   triggers clears at 120k and 150k tokens (`auto-clear.ts:11`), then depends on the
   keystroke script to resume. Handoff memory files and `LAST_MESSAGE.md` persistence
   (AISDLC-914) exist because the resume is unreliable.
5. **Size.** About 2,600 of the 11,957 non-test hierarchy lines are tmux, clear,
   identity and start code, plus 744 lines of related hooks. Thirteen backlog tasks
   trace to this layer: AISDLC-738, 741, 759, 766, 806, 827, 870, 886, 912, 1007, 1025,
   1028, 1029 (and now 1032).
6. **Relays cost model turns.** Every cross-session message goes through the model's
   SendMessage tool and lands as a model turn on the other side (a commenter on
   anthropics/claude-code 99049 measured about 5.5k tokens and 3 to 7 s per relayed
   message). Tick notes and digests are model-written prose, so a digest can carry a
   stale PR list that code would have read correctly.
7. **Operator time.** Typing resume commands, restarting `unknown`-state executors and
   re-registering after degraded clears is daily work; on 2026-10-22 two of five
   adopter executors started the day in state `unknown`.

### Why now

The Mods API is the first supported path to steer an interactive session from code.
The upstream tracker shows about 280 reactions across programmatic-session-control
issues with no staff reply (17428, 27242, 11455, 19877, 89783), agent-triggered
compaction stale-closed (71803), and agent teams still tmux-bound (31901, 26572,
23669). The Mods design thread (anthropics/claude-code 91870) is the one place the team
is answering and shipping from user requests, so findings from this RFC's spike have a
venue.

## Goals

- Delete the tmux keystroke layer: pane-text idle detection, typed `/clear` and resume
  commands, start tokens, the pid walk, the Stop-hook transcript parser, the background
  `--wait` hack and the idle-backoff sleep loop.
- Keep the billing property: every hierarchy session remains an interactive session;
  no `claude -p` and no API-key fallback.
- Keep the board as the unit of execution and the brief as the unit of hand-off
  (RFC-0051). Authority stays on disk and in decision records on `main`.
- Make routine traffic (verdict written, PR landed, status digest) cost zero model
  turns on the receiving side.
- Give the operator a live pane view of the board instead of model-written notes.
- Measure the saving (tokens, seconds, operator interventions) before the design is
  marked Ready.

## Non-Goals

- Changing what the board, the briefs, `cli-dispatch` or the decision catalog mean.
- Re-deciding the operator-dispatch role. RFC-0056 OQ-5 (resolved 2026-10-20, on
  `main`) retires it: a deterministic scheduler runs `tick`, `sweep` and `reconcile`,
  escalations are board files, the planner is the only LLM in the control loop and
  executors stay sessions. RFC-0057 (reserved) specifies that scheduler. This RFC never
  prompts a dispatch model; it gives the scheduler its wake and send primitives, and
  OQ-6 asks only where the scheduler process lives.
- Verified sender identity across sessions. The Mods origin field is self-asserted;
  closing that gap is an upstream request (see "Upstream gaps").
- Signed proof of what a subagent ran (RFC-0042 §267-279 limits); a separate feature
  request covers it.

## Five-step pass (DEC-0090 order)

1. **Question the requirement.** "A hierarchy session must be driven from outside by a
   terminal multiplexer." False since Mods: a session can be driven from inside by code
   that it loads itself, with the same billing.
2. **Delete.** `clear.ts` keystroke script and pane-text idle detection;
   `start-token.ts`; the `caller-identity.ts` pid walk; the `check-sender` sender
   flags; the Stop-hook auto-clear transcript parser; the `executor-start --wait`
   background pattern; `idle-backoff`; `LAST_MESSAGE.md` persistence once `$.store`
   holds the last reply.
3. **Simplify.** One hooks module, three roles, one event loop per session. Messages
   between sessions are typed events consumed in code; the model is submitted a prompt
   only when judgement is needed.
4. **Accelerate.** A wake is `$.prompt.submit`, not a 30 s pane poll; a relay is a hook
   call, not a 5.5k-token model turn; rotation fires on `session.measure`, not on a
   Stop hook reading a transcript.
5. **Automate.** The spike (Implementation Plan phase 0) measures the saving and the
   `/clear` behaviour; `claude plugin test` and the engine-written types check the mod
   in CI.

## Proposal

### One hierarchy mod, three roles

The ai-sdlc plugin gains a `hierarchy` hooks module (`hooks/hooks.json` lists it under
`modules`; `hooks/hierarchy/register.tsx` exports `register(on, options)`). At
`session.start` it reads its role from `hierarchy.json` or `HIERARCHY_ROLE`, exactly
as `hierarchy-role.js` does today, and registers only that role's behaviour. A session
without a role registers nothing.

### The scheduler role has no model

The operator-dispatch role is retired (RFC-0056 OQ-5). What remains is a deterministic
scheduler, specified by RFC-0057, that runs `$.clock.every` for the tick and calls the
existing `cli-dispatch` and `cli-hierarchy tick` through `$.process.run`. Board events
arrive by `session.receive` and are consumed by the hook (`{ consumed }`), written to
the board and to a `ui.render` pane, and never reach a model. An unclassified failure
shape becomes an escalation file on the board for the planner (failure record, log
tail, PR check summary), never a prompt to a dispatch model. OQ-6 asks only whether
this scheduler is hosted by a mod in a model-less session or runs as a daemon outside
any session.

### Executors are woken, not cleared into life

When a task is enqueued, dispatch calls `$.session.send({ to: <executor roster name>,
text })`. The executor mod's `session.receive` hook consumes it and calls
`$.prompt.submit({ text: '/ai-sdlc:executor' })`, which starts a turn once the session
is idle. After the verdict the executor mod runs the clear itself (`$.command.run({
command: 'clear' })` if OQ-1 confirms, else `$.session.compact` with a
hierarchy-specific summary prompt) and waits idle at zero cost. `executor-start` keeps
its claim semantics but no longer needs `--wait`, a token or a sender flag: the claim
on the board is the authority, as RFC-0051 states.

### Context rotation from inside

`session.measure` (figures pushed after each main-thread turn) replaces the Stop-hook
transcript parser. At the role's threshold the mod runs `cli-hierarchy handoff write`,
clears or compacts, and resubmits the role command. `$.store` keeps the role and the
last reply across the clear, replacing `LAST_MESSAGE.md`.

### Sender checks shrink to a mistake guard, by design

`SessionReceiveOrigin.plugin` is "as the sender says": the docs instruct never to key
a guard on it. The mod keeps the roster-name check (address only names the roster
lists) and drops the pid walk and the start token. Nothing in a message grants
authority; the board claim and decision records on `main` do (CLAUDE.md "Decision
authority", RFC-0051). This RFC records the gap as a known limit and as an upstream
request.

### Panes

`cli-hierarchy status` and the tick notes become a `ui.render` pane in the dispatch
session, read from the board. tmux is kept, if at all, as a window manager (OQ-3).

### Delete list and keep list

| Delete | Keep |
|---|---|
| `clear.ts` keystroke script, pane-text idle detection | board directories, `done/`, `failed/`, verdicts |
| `start-token.ts`, `caller-identity.ts` pid walk, `check-sender` flags | briefs and `cli-hierarchy brief / status / handoff` |
| Stop-hook `auto-clear.ts` transcript parser | `cli-dispatch` claim, complete, reenter, release |
| `executor-start --wait` background pattern, `idle-backoff` | the decision catalog and `cli-decisions` |
| `LAST_MESSAGE.md` persistence (AISDLC-914) | handoff memory files (written by the mod at rotation) |

## Design Details

### Mods primitives used, verified against build 2.1.304

| Hierarchy need today | Mods primitive | Source note |
|---|---|---|
| Type a resume command into a pane | `$.prompt.submit({ text, asUser? })` | "a plugin's prompt runs once idle"; resolves `{ drop: reason }` instead of throwing when refused |
| Type `/clear` or `/compact` | `$.command.run({ command, args? })`, `$.session.compact({ instructions })` | `command` names a slash command without its slash; `compact` is a documented example; `clear` unconfirmed (OQ-1) |
| Decide when to clear | `session.measure`, `$.session.usage()` | pushed after each main-thread turn; `startedAt` restarts at `/clear` |
| Detect idle by pane text | `turn.start`, `turn.complete` | fire for the main loop and subagents (`e.agentId`); `turn.complete` carries `e.reason` |
| Know a clear or exit happened | `session.end` | reasons `clear`, `resume`, `logout`, `prompt_input_exit`, `other` |
| Relay through the model | `$.session.send`, `on('session.receive')` | fires before queueing; `{ consumed }` keeps the model silent |
| Sender authentication | `SessionReceiveOrigin` | kinds `peer`, `coordinator`, `peer-send-message`, `bridge`, `task-notification`, `scheduled-trigger`, `unclassified`; `plugin` self-asserted |
| Sleep loops, 600 s Bash cap | `$.clock.every`, `$.clock.after`, `$.clock.sleep` | timers inside the session; background work after interruption handled from 2.1.304 |
| Fan out executors | `$.agent.spawn({ prompt, model?, name?, cwd? })`, `$.agent.list()` | status `idle` or `running`; teammates in a pane of their own supported |
| Session facts | `$.session.id()`, `$.session.model()`, `$.session.turns()` | direct reads; `turn.step` carries the model per request |
| Operator identity | `$.session.identity()` | answered only to a managed install (OQ-4) |
| Pane dashboards | `$.ui.open`, `ui.render`, `$.ui.status`, `$.ui.toast` | live views beside the chat |
| Tool-call policy | `on('tool.call', { tool }, hook)` returning `{ deny }` | the PreToolUse job with typed input; `sec-default@builtin` loads first |
| Persist across clears | `$.state` (session), `$.store` (across sessions) | `/clear` ends the session, so hierarchy state belongs in `$.store` or on the board |

### Role behaviour

- **Planner.** Registers `session.measure` rotation at 150k tokens with
  `handoff write --role planner` first; `session.receive` passes planner-addressed
  rulings and escalations through to the model unchanged (they need judgement) and
  consumes status noise. The "only your own roster" rule becomes a `to` check in the
  send wrapper.
- **Scheduler (RFC-0057, replaces dispatch).** `$.clock.every` tick; `session.receive`
  consumes verdicts, PR events and executor status lines, applies them with
  `cli-dispatch` and updates the pane; writes an escalation file for the planner on an
  unclassified failure shape. No prompt is ever submitted, so no rotation.
- **Executor.** Idle until `session.receive` carries an enqueue from the dispatch
  roster name; then `$.prompt.submit('/ai-sdlc:executor')`. The executor command keeps
  its one-task-per-context rule; the mod clears after the verdict and re-registers.
  Rotation at 120k, never mid-task (the mod waits for `turn.complete` of the task's
  last step).

### Loading and testing

Three files: `.claude-plugin/plugin.json`, `hooks/hooks.json` with `"modules":
["./hierarchy/register.tsx"]`, and the module. It hot-reloads from `--plugin-dir`,
validates with `claude plugin validate`, tests with `claude plugin test` and
type-checks against engine-written types. `plugin.register` lets a managed mod refuse
other modules; `next.to(e, tier)` and `prependPlugins` order the chain (OQ-4).

### Upstream gaps this RFC does not close

- No verified sender on cross-session messages (both the SendMessage envelope and
  `SessionReceiveOrigin.plugin` are self-asserted). Ask for a harness-signed sender
  session id in the Mods thread 91870.
- No signed proof of what a subagent ran (RFC-0042 §267-279; `CLAUDE_SESSION_ID` is
  absent from subprocess env, `harness-transcript.ts:337-360` picks the most recently
  modified session directory). Feature request drafted separately.
- Model id reaches classic hooks only at SessionStart; the mod can record the
  effective model per tool call from `turn.step` (relevant to RFC-0042 and RFC-0050).
- No parsed Bash subcommands for hooks; the lease-push guard keeps its tokenizer.

## Backward Compatibility

- The board, brief and verdict file formats do not change; a mixed fleet (some
  sessions on the mod, some on tmux driving) works during the rollout because both
  read the same board.
- `cli-hierarchy up` keeps launching sessions; the `clear` subcommand is kept as a
  thin call to the mod (`$.session.send` of a rotate request) until the keystroke path
  is deleted, then removed.
- Adopters below the minimum Claude Code version (OQ-5) stay on the tmux layer of the
  previous plugin release; the plugin refuses to load the hierarchy module on an older
  build and says why.
- Classic hooks (`SessionStart`, `PreToolUse`, `Stop`) keep working beside the mod;
  only the auto-clear Stop hook is retired.

## Alternatives Considered

1. **Keep tmux driving and harden it** (AISDLC-1029 retries, 1032 session tokens).
   Rejected: every fix adds a heuristic over screen text; the failure classes (swallowed
   keys, busy input line, no identity line) are inherent to typing blind.
2. **Headless `claude -p` daemons for dispatch and executors.** Rejected by RFC-0051
   Non-Goals and RFC-0041 §4.1: loses the subscription billing property.
3. **Agent teams (`$.agent.spawn` teammates) instead of separate sessions.**
   Considered for executors; kept as an option inside OQ-3 (headless panes). Teammates
   are tmux-bound upstream today and share the parent's context budget rules.
4. **A separate mod package outside the plugin.** Kept as OQ-2.
5. **Do nothing until RFC-0057 retires dispatch.** Rejected: executors and the planner
   keep the keystroke layer regardless of the dispatch role's fate.

## Implementation Plan

- **Phase 0, spike (one task, about a day, no production change).** A minimal mod with
  `session.start`, `turn.complete`, `session.measure`, `session.receive`, `session.end`
  hooks that log to a file, plus a `/hier-ping` command. From a second session,
  `$.session.send` by name; confirm `session.receive` fires and `{ consumed }` keeps
  the model silent. Call `$.command.run({ command: 'clear' })` then `$.prompt.submit({
  text: '/hier-ping' })`; record whether the clear runs, the mod reloads, `$.store`
  survives and the prompt starts a turn once idle. Measure tokens and seconds for a
  mod-handled message against a model-relayed SendMessage. Answers OQ-1 and feeds the
  measured saving into this RFC before Ready for Review.
- **Phase 1, executor wake and rotation.** Hierarchy module with the executor role:
  enqueue message consumed, `$.prompt.submit` wake, in-session clear or compact,
  `session.measure` rotation. `executor-start` loses `--wait`, the token and the
  sender flags. Delete `start-token.ts`.
- **Phase 2, scheduler event loop (with RFC-0057).** Scheduler role: `$.clock.every`
  tick, consumed board events, `ui.render` status pane, `$.session.send` wake of
  executors, escalation files for the planner. Delete `idle-backoff`, the dispatch
  half of `clear.ts` and the `/ai-sdlc:operator-dispatch` command. Depends on OQ-6.
- **Phase 3, planner rotation and roster guard.** Planner role: rotation with handoff
  write first, roster-name send wrapper, `$.store` last reply. Delete `LAST_MESSAGE.md`
  persistence and the Stop-hook auto-clear.
- **Phase 4, delete the keystroke layer.** Remove `clear.ts` pane script,
  `caller-identity.ts` pid walk, `check-sender` flags; `cli-hierarchy clear` becomes a
  rotate request. Docs: `docs/operations/cli-hierarchy.md` and the operator runbook.
- **Phase 5, RFC-0056 phase 5 unblocked.** With the scheduler in place and the
  dispatch role gone, RFC-0056 phase 5 (which requires RFC-0057) can proceed.

Tasks are filed after the OQ walkthrough (rfc-oq-walkthrough skill), not with this
draft.

## Open Questions

### OQ-1: Can a mod run the built-in `/clear`, and does `$.store` survive it?

`$.command.run({ command })` names a slash command without its slash and the docs
give `compact` as an example, but `clear` is not confirmed; `session.end` fires with
reason `clear` when `/clear` runs, which suggests the engine can observe it. Options:
(a) `/clear` through `$.command.run` with `$.store` carrying role and last reply (fresh
context, cheapest turns); (b) `$.session.compact` with a hierarchy-specific summary
prompt (fully documented, context not fresh, summary quality varies); (c) end the
session and let `cli-hierarchy up` relaunch it (loses in-session state, keeps today's
semantics). Phase 0 answers (a); the operator picks the fallback order.

### OQ-2: Ship inside the ai-sdlc plugin or as a separate mod?

(a) One hooks module in the ai-sdlc plugin: one install, versioned with the CLI it
calls, same release train; a hierarchy bug ships with every plugin release. (b) A
separate `ai-sdlc-hierarchy` mod: installable alone, smaller blast radius, its own
version pin, and a second thing for adopters to install and keep in step.

### OQ-3: Keep tmux as a window manager, or go headless with `ui` panes?

(a) Keep tmux windows for human visibility; the mod never sends keys. (b) Replace
panes with `$.ui.open` views in one session and run executors as `$.agent.spawn`
teammates or background sessions. (c) Both, chosen by `hierarchy.json`. Affects
`cli-hierarchy up`, `attach`, `terminals` and the operator runbook.

### OQ-4: Require a managed (organization) install?

`$.session.identity()` answers only a managed mod, and `plugin.register` refusals and
chain ordering (`prependPlugins`) are managed-install features. (a) Require managed
install for the hierarchy (operator identity in attestations, mods cannot be shadowed);
(b) user tier is enough and identity comes from the login record as today; (c) user
tier by default, managed features used when present.

### OQ-5: Minimum Claude Code version

The operator's build is 2.1.304; background work after an interruption is handled from
2.1.304; the API is evolving on issue 91870. (a) Pin the exact build the spike passes
on and raise it per phase; (b) a floor plus a capability probe at `session.start`
(`$.session.version()`) that refuses to register with a named reason; (c) track
latest and accept breakage.

### OQ-6: Where does the RFC-0057 scheduler run?

The retirement of the operator-dispatch role is decided (RFC-0056 OQ-5, on `main`)
and is not reopened here. What is open is the host of the deterministic scheduler.
(a) A mod in a model-less session: the scheduler gets `$.session.send`, `$.clock` and
`ui.render` for free, a session slot is held with zero model turns, and the hierarchy
has one runtime; (b) a daemon outside any session (the reconcile scheduler already is
one): no session held, but it needs its own wake path to executors (today's clear, or
a socket the executor mod listens on) and no `ui` pane; (c) this RFC absorbs the
RFC-0057 specification and the reserved number is released. Sequencing: phases 0 and 1
are independent of the answer; phase 2 depends on it.

## References

- RFC-0041 (Conductor as a session; §4.1 billing), RFC-0042 (attestation limits
  §267-279), RFC-0051 (session hierarchy; board and brief semantics; Non-Goals),
  RFC-0054 (event-driven PR lifecycle; reconcile scheduler), RFC-0056 OQ-5 (RFC-0057
  reserved for retiring the operator-dispatch role).
- Source report: ai-sdlc-io planner, 2026-10-22, "Report to ai-sdlc-planner: replace
  the tmux session hierarchy with a Claude Code Mod" (adopter repo
  `.claude/memory/reports/2026-10-22-mods-instead-of-tmux-report.md`), with the type
  file extract for build 2.1.304, fetched Mods docs (`mods.md`, `mods_api.md`,
  `plugins_mods_reference.md`) and raw tracker searches under
  `.claude/memory/reports/raw-2026-10-22/`.
- Code cited: `pipeline-cli/src/hierarchy/clear.ts`, `start-token.ts`,
  `caller-identity.ts`, `auto-clear.ts`, `executor-start.ts`;
  `ai-sdlc-plugin/commands/executor.md`; `docs/operations/cli-hierarchy.md`;
  `docs/operations/billing-and-cost-optimization.md`.
- Upstream: anthropics/claude-code issues 91870 (Mods design thread), 24798 (cross-
  session messaging shipped v2.1.224), 99049, 85888, 99427, 17428, 27242, 11455, 19877,
  89783, 71803, 31901, 26572, 23669.
- Backlog: AISDLC-738, 741, 759, 766, 806, 827, 870, 886, 912, 914, 1007, 1025, 1028,
  1029, 1032.

## Sign-Off

| Role | Owner | Status | Date |
|---|---|---|---|
| Engineering | Dominique Legault | pending | |
| Operator | Dominique Legault | pending | |
| Product | | pending | |
| Design | | not applicable | |

## Revision History

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-10-22 | Draft from the ai-sdlc-io planner's Mods report; six Open Questions, none resolved; phase 0 spike before Ready for Review. |
