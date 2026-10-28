---
id: RFC-0058
title: Session Hierarchy on the Claude Code Mods API (retire the tmux keystroke layer)
status: Signed Off
lifecycle: Signed Off
author: 'Dominique Legault'
created: 2026-10-22
updated: 2026-10-22
requires: []
assumes: [RFC-0041, RFC-0042, RFC-0051, RFC-0054, RFC-0056]
requiresDocs:
  - operator-runbook
targetSpecVersion: v1alpha1
---

<!-- ai-sdlc:lifecycle-jump-approved-by:deefactorial reason:operator resolved all six OQs with the full rubric and signed Engineering and Operator in the 2026-10-22 walkthrough; Ready for Review is skipped because the same operator is author, engineering and operator authority -->

# RFC-0058: Session Hierarchy on the Claude Code Mods API

**Status:** Signed Off, v0.2 (2026-10-22). Six Open Questions, all resolved with the
operator on 2026-10-22 (full rubric; see the `**Resolution**` blocks in §Open
Questions): rotation order clear > compact > relaunch (OQ-1); one role-gated hooks
module inside the ai-sdlc plugin (OQ-2); tmux kept as a window manager only, sessions
stay separate (OQ-3); user tier by default, managed features when present (OQ-4); version
floor plus a capability probe that refuses with a named reason (OQ-5); the model-less
dispatch session hosts the RFC-0057 scheduler (OQ-6). Cross-cutting rule added: a Mods
gap is reported upstream first and any workaround is interim and cites the issue.
Engineering + Operator signed 2026-10-22; implementation tasks AISDLC-1033 to 1037.
Authored from the ai-sdlc-io planner's report of 2026-10-22 ("replace the tmux session
hierarchy with a Claude Code Mod"), written at the operator's request.

**Lifecycle:** Signed Off
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
- Deciding whether the operator-dispatch role survives: that is RFC-0057 (reserved by
  RFC-0056 OQ-5). This RFC gives RFC-0057's scheduler its wake and send primitives and
  states the relation as OQ-6.
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

### Dispatch becomes event-driven

The dispatch role runs `$.clock.every` for the reconcile tick and calls the existing
`cli-dispatch` and `cli-hierarchy tick` through `$.process.run`. Board events arrive by
`session.receive`; routine ones (verdict written, PR landed, status digest) are
consumed by the hook (`{ consumed }`), written to the board and to a `ui.render` pane,
and never reach the model. A prompt is submitted to the dispatch model only when the
tick reports something the policy tables cannot classify. Whether that model is kept
at all is RFC-0057's question (OQ-6).

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
  send wrapper: address roster names, or reply to the `from` address of a message you received; never a name from memory or convention.
- **Dispatch.** `$.clock.every` tick; `session.receive` consumes verdicts, PR events
  and executor status lines, applies them with `cli-dispatch` and updates the pane;
  submits a prompt only for an unclassified failure shape (or, under RFC-0057, writes
  an escalation file for the planner instead). Rotation at 120k.
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

**Rule (operator, 2026-10-22 walkthrough, applies to every phase):** when a need of
this design cannot be met with the Mods API, the action path is to report the gap
upstream (the Mods design thread, anthropics/claude-code 91870, or a new issue) and, if
the phase cannot wait, to ship a workaround marked interim that cites the upstream
issue and is removed when the upstream fix lands. A permanent heuristic over the
harness (pane text, pid walks, typed keys) is never the answer; that is the layer this
RFC deletes.

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
  measured saving into this RFC before Ready for Review. Measured (live run, PR #1946):
  about 2.0 s and 66 output tokens saved per hook-consumed message versus the model
  relay (hook path median 7.5 ms and 0 model tokens; model path median 2.05 s).
- **Phase 1, executor wake and rotation.** Hierarchy module with the executor role:
  enqueue message consumed, `$.prompt.submit` wake, in-session clear or compact,
  `session.measure` rotation. `executor-start` loses `--wait`, the token and the
  sender flags. Delete `start-token.ts`.
- **Phase 2, dispatch event loop.** Dispatch role: `$.clock.every` tick, consumed
  board events, `ui.render` status pane, `$.session.send` wake of executors. Delete
  `idle-backoff` and the dispatch half of `clear.ts`.
- **Phase 3, planner rotation and roster guard.** Planner role: rotation with handoff
  write first, roster-name send wrapper, `$.store` last reply. Delete `LAST_MESSAGE.md`
  persistence and the Stop-hook auto-clear.
- **Phase 4, delete the keystroke layer.** Remove `clear.ts` pane script,
  `caller-identity.ts` pid walk, `check-sender` flags; `cli-hierarchy clear` becomes a
  rotate request. Docs: `docs/operations/cli-hierarchy.md` and the operator runbook.
- **Phase 5, hand-off to RFC-0057.** Expose the mod's wake and send primitives to the
  deterministic scheduler RFC-0057 specifies; this RFC does not decide the role's
  retirement.

Tasks: AISDLC-1033 (phase 0 spike), 1034 (phase 1), 1035 (phase 2), 1036 (phase 3),
1037 (phase 4), filed with the 2026-10-22 walkthrough. Phase 5 is the scheduler body
RFC-0057 specifies and is filed with that RFC.

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

**Resolution (2026-10-22, full rubric):** **(a) with a fixed fallback order: clear >
compact > relaunch.** The mod writes the handoff first, then `$.command.run({ command:
'clear' })` with `$.store` carrying the role, the resume command and the last reply;
when that resolves `{ drop }` it runs `$.session.compact` with a hierarchy summary
prompt; only when both fail does it end the session for `cli-hierarchy up` to relaunch.
Industry research: `/compact` is the documented in-session path and `/clear` ends the
session (`session.end` reason `clear`); long-running agent frameworks (LangGraph
checkpointers, OpenAI Agents SDK sessions) keep state outside the context window and
treat the window as disposable, which is the board plus `$.store`. **Shipped
substrate:** today's rotation already runs handoff write, then clear, then resume; the
mod keeps that order and `$.store` replaces only `LAST_MESSAGE.md`. **Counter-argument:**
"compact is the documented contract; building on an unconfirmed clear invites the
heuristic layer this RFC deletes." Rebuttal: the phase 0 spike settles clear with a hard
yes or no in a day, and the fallback order makes compact the first path with no design
change if the answer is no. **Selected over compact-only because executors need an
empty window per task, not a growing summary; over relaunch-only and clear-only because
both leave a session dependent on an outside relauncher or an operator.**

### OQ-2: Ship inside the ai-sdlc plugin or as a separate mod?

(a) One hooks module in the ai-sdlc plugin: one install, versioned with the CLI it
calls, same release train; a hierarchy bug ships with every plugin release. (b) A
separate `ai-sdlc-hierarchy` mod: installable alone, smaller blast radius, its own
version pin, and a second thing for adopters to install and keep in step.

**Resolution (2026-10-22, full rubric):** **(a) one hooks module in the ai-sdlc plugin,
registering nothing unless a hierarchy role is set.** Split-out trigger recorded: only
when a consumer outside ai-sdlc appears. Industry research: the plugin already gates
behaviour on the role (`hierarchy-role.js` no-ops without `HIERARCHY_ROLE`); editors
(VS Code, JetBrains) bundle tightly coupled parts in one extension and split only on an
independent release cadence or audience, which the hierarchy lacks; the repo's one
release train (release-please, `lint:publishable`) and the plugin-version check exist
because pins drift. **Counter-argument:** "a broken hooks module crashes session start
for every adopter, including those who never run the hierarchy." Rebuttal: `register`
reads the role before touching any primitive and returns on no role; `claude plugin test`
covers that path in CI. The CLI/mod skew of a second pin (b) would hit every hierarchy
user on every release. **Selected over (b) because the module calls `cli-dispatch` and
`cli-hierarchy`, whose contracts change with every pipeline-cli release; an opt-in
`hierarchy.json` listing adds a switch the role env already provides.**

### OQ-3: Keep tmux as a window manager, or go headless with `ui` panes?

(a) Keep tmux windows for human visibility; the mod never sends keys. (b) Replace
panes with `$.ui.open` views in one session and run executors as `$.agent.spawn`
teammates or background sessions. (c) Both, chosen by `hierarchy.json`. Affects
`cli-hierarchy up`, `attach`, `terminals` and the operator runbook.

**Resolution (2026-10-22, full rubric):** **(a) tmux stays as a window manager only;
sessions stay separate OS sessions; the mod never sends keys.** The dispatch session
gains a `ui.render` board pane. Re-evaluate headless (b) when upstream teammates stop
depending on tmux and gain a lifecycle independent of the parent session. Industry
research: agent teams are tmux-bound upstream today (31901, 26572, 23669); `$.agent.spawn`
teammates share the parent's lifecycle, so a parent clear or crash takes every executor
down, against RFC-0051's one-task-per-context rule; supervisors elsewhere (Kubernetes,
systemd) keep the viewer replaceable and the process model fixed. **Counter-argument:**
"tmux is what this RFC retires; keeping it keeps the install burden and the habit of
typing into panes." Rebuttal: the RFC retires typing into panes, not windows; every
failure class in §Motivation is a keystroke failure, and a window that is only read has
none. **Selected over (b) because teammates are parent-coupled and tmux-bound upstream;
over (c) because one adopter does not justify two process models.** The operator added
the cross-cutting rule recorded under "Upstream gaps": a Mods gap is reported upstream
first, and a workaround is interim and cites the issue.

### OQ-4: Require a managed (organization) install?

`$.session.identity()` answers only a managed mod, and `plugin.register` refusals and
chain ordering (`prependPlugins`) are managed-install features. (a) Require managed
install for the hierarchy (operator identity in attestations, mods cannot be shadowed);
(b) user tier is enough and identity comes from the login record as today; (c) user
tier by default, managed features used when present.

**Resolution (2026-10-22, full rubric):** **(c) user tier by default; managed features
used when present, never required.** At `session.start` the module probes: when
`$.session.identity()` answers, the identity is recorded as an informational field
beside the signed attestation (RFC-0042), never as authority; when `plugin.register`
refusal is available the hierarchy refuses modules it does not know, else it logs the
loaded chain. The start line names the detected tier and the active guards next to the
role. Industry research: attestation identity already comes from the ed25519 key and
the DSSE envelope, so harness identity would be a second, weaker claim beside a signed
one; enterprise-only gating (Slack, GitHub rulesets) is accepted for organisational
policy, not basic function; progressive enhancement (browser feature detection) is the
normal shape for optional platform capabilities. **Counter-argument:** "the security
story then differs by install tier and adopters will not know which they have."
Rebuttal: the mod states the tier at start, and nothing security-relevant depends on
it because authority stays on the board and in decision records on `main`. **Selected
over (a) because this repository could not adopt on its own user-tier install; over (b)
because the probe is cheap and the identity field feeds RFC-0042 later.**

### OQ-5: Minimum Claude Code version

The operator's build is 2.1.304; background work after an interruption is handled from
2.1.304; the API is evolving on issue 91870. (a) Pin the exact build the spike passes
on and raise it per phase; (b) a floor plus a capability probe at `session.start`
(`$.session.version()`) that refuses to register with a named reason; (c) track
latest and accept breakage.

**Resolution (2026-10-22, full rubric):** **(b) a version floor plus a capability probe
at `session.start` that refuses to register with a named reason.** The floor is the
build the phase 0 spike passes on (recorded by that task; the operator's build moved
from 2.1.304 to 2.1.307 while this RFC was drafted). The module checks
`$.session.version()` against the floor and probes each primitive it registers for
(`prompt.submit`, `command.run`, `session.compact`, `session.measure`, `session.send`,
`clock.every`, `ui.render`); on any miss it registers nothing and logs one line naming
the missing primitive and the floor. The floor is raised only when a phase depends on a
newer primitive. Industry research: npm `engines` plus runtime feature detection; VS
Code `engines.vscode` floor plus proposed-API checks at activation; the repo's own
`check-plugin-version.js` and DEC-0264 (pins enforced with a named reason, never
silently). **Counter-argument:** "a probe proves a function exists, not that its
semantics held; a renamed `reason` enum breaks rotation with the probe green."
Rebuttal: true, which is why `claude plugin test` against engine-written types runs in
CI; the probe covers the runtime half, the typed test the semantic half, and an exact
pin (a) would not catch semantics either. **Selected over (a) because adopters must be
able to upgrade Claude Code without waiting on a plugin release; over (c) because
silent wedges in unattended runs are the problem being solved.**

### OQ-6: Relation to RFC-0057 (retire the operator-dispatch role)

RFC-0056 OQ-5 reserved RFC-0057 for a deterministic scheduler that runs `tick`,
`sweep` and `reconcile`, with the planner as the only LLM in the control loop and
executors staying sessions. This RFC's dispatch role is the same loop hosted in a mod.
(a) The dispatch mod is RFC-0057's scheduler host: the dispatch session keeps running
but its model is never prompted (model on standby, zero turns); (b) RFC-0057 runs the
scheduler as a daemon outside any session and this RFC ships only planner and
executor roles; (c) this RFC absorbs RFC-0057 and the reserved number is released.
Sequencing: phases 0 to 1 are independent of the answer; phase 2 depends on it.

**Resolution (2026-10-22, full rubric):** **(a) the model-less dispatch session hosts
the RFC-0057 scheduler.** The hierarchy module in the dispatch role runs the scheduler
on `$.clock.every`, consumes board events in `session.receive`, renders the board pane
and sends wakes with `$.session.send`; it never submits a prompt to its model.
RFC-0057 specifies the scheduler's policy tables and escalation files and `requires:`
phases 0 to 2 of this RFC. Phase 2 here ships the host with today's `cli-hierarchy
tick` as its body; RFC-0057 replaces the body. Industry research: supervisors live
inside the thing they supervise when the control primitives are reachable only from
inside (Erlang supervisors, Kubernetes controllers as pods) and move to a sidecar when
an API exists; `$.session.send` and `$.prompt.submit` are callable only from a mod
inside a session, and the programmatic-session-control issues (17428, 27242, 11455,
19877, 89783) have no staff reply; a session whose model is never prompted costs zero
turns on the subscription. **Counter-argument:** "a session that never prompts its
model is a daemon in a costume; when upstream ships session control over an API the
design is wrong." Rebuttal: the costume is what makes the primitives reachable today,
and the "Upstream gaps" rule names the exit: policy lives in RFC-0057 and
`cli-dispatch`, so the scheduler body moves out unchanged when an external API can
wake and send. **Selected over (b) because it cannot be built today; over (c) because
policy and transport belong in separate RFCs and RFC-0056 phase 5 depends on RFC-0057
by number.**

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
| Engineering | Dominique Legault | ✅ Signed (six OQs resolved with the full rubric; keystroke layer retired by design, authority stays on the board) | 2026-10-22 |
| Operator | Dominique Legault | ✅ Signed (tmux kept as a window manager only; Mods gaps go upstream first, workarounds are interim) | 2026-10-22 |
| Product | | pending | |
| Design | | not applicable | |

## Revision History

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-10-22 | Draft from the ai-sdlc-io planner's Mods report; six Open Questions, none resolved; phase 0 spike before Ready for Review. |
| v0.2 | 2026-10-22 | OQ walkthrough with the operator (full rubric, 6/6 resolved): OQ-1 clear > compact > relaunch with `$.store`; OQ-2 one role-gated hooks module in the plugin; OQ-3 tmux as window manager only, separate sessions, headless revisited when upstream teammates leave tmux; OQ-4 user tier default, managed features when present; OQ-5 version floor plus capability probe refusing with a named reason; OQ-6 model-less dispatch session hosts the RFC-0057 scheduler, phase 2 ships the host. Cross-cutting rule under "Upstream gaps": report Mods gaps upstream first, workarounds interim. Lifecycle Signed Off; Engineering + Operator signed; tasks AISDLC-1033 to 1037. |
