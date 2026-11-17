---
id: AISDLC-1299
title: 'Webhook feed restarts itself when it is silent or its agent is not running'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - dispatch
  - webhook
  - rate-limit
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook-forwarder.ts
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/webhook-health.ts
  - pipeline-cli/src/hierarchy/webhook-health.test.ts
  - pipeline-cli/src/hierarchy/webhook.test.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: 'Operator request (restated 2026-11-17): the webhook forwarder is to be a service that keeps the feed alive. What exists keeps a process alive under launchd (AISDLC-1207, AISDLC-1285) and, when the feed is silent, only opens a decision for the operator (DEC-0402, DEC-0406, DEC-0407, DEC-0408, DEC-0409 in two days). On 2026-11-17 the feed delivered nothing for 20 hours: the installed agent file predates AISDLC-1285 and its job exits 126 every 30 seconds (2,684 identical lines in `webhook-forward.log`), and dispatch polls gh about 1,900 times an hour instead. The remedy the decision asks the operator for is a restart; the machine can do that restart itself.'
---

## Description

**Gap.** Three cases leave the feed dead with nobody acting:

1. **Agent loaded, not running.** The launchd job exits at once and is respawned every 30 seconds for ever (here: an agent file written before AISDLC-1285, `Operation not permitted` on the board's `gh` wrapper, last exit 126). Health reports it, nothing repairs it.
2. **Agent running, feed silent.** `gh webhook forward` can stay alive after its websocket has closed, or exit with `websocket: close 1006 (abnormal closure)`. `forwarderSignal` in `webhook.ts` reads only "the job is running", so a silent forwarder counts as `alive`.
3. **Agent file out of date.** An agent file of an older shape survives every plugin update; `webhook up` is the only thing that rewrites it and only the operator runs it.

In all three, `webhook-health.ts` opens a decision whose only useful option is "operator restarts the forwarder".

**Shape.** When the feed is `down` or `degraded` because of silence or a dead forwarder, the dispatch tick first repairs it without the operator: restart the job, and rewrite the agent file when it is out of date and the secret is available. A decision is opened only after the repair attempts are used up, and it says what was tried and what the forwarder log says.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must a person restart the feed? No: a restart of an already installed agent touches nothing new on the GitHub account; the agent was installed by the operator with their secret. 2. Deleted: the decision record as the first response to a silent feed. 3. Simplified or optimised: one repair step with a bounded number of attempts, reusing the health classification that exists. 4. Accelerated: repair happens at the tick that sees the fault, not after a person reads a decision. 5. Automated: the tick runs it.

- **Repair step.** In the tick, when webhook health is `down` or `degraded` for silence while a pull request changed, or the forwarder signal is `dead`, and the recorded feed is a launchd agent: run `launchctl kickstart -k gui/<uid>/<label>` and record the attempt (time, reason, result) in the webhook health state file on the board. At most 3 attempts per rolling 60 minutes, at least 5 minutes apart. Health recovering (an event arrives) resets the count.
- **Out-of-date agent file.** Before a kickstart, compare the installed agent file with what `webhook up --feed gh-forward` would write now, ignoring the secret value. When they differ and `AI_SDLC_WEBHOOK_SECRET` is set in the tick's environment, reinstall through the existing install function. When they differ and the secret is not set, do not kickstart; go straight to the decision with the reason `agent file out of date, secret not available to the tick`.
- **Decision only after repair.** The webhook decision is opened only when the attempts are used up or the repair is not possible. Its body lists each attempt and the last 5 lines of `webhook-forward.log`, with any value following `--secret` or `AI_SDLC_WEBHOOK_SECRET=` replaced by `[redacted]`. The existing close-on-recovery behaviour stays.
- **Status.** `cli-hierarchy webhook status` and the `webhook:` line of `cli-hierarchy status` show `loaded, not running (last exit <code>)` distinctly from `running`, and the count of repair attempts in the last hour.
- **Platform.** On a platform without launchd, or for a feed that is not a launchd agent, the repair step does nothing and the behaviour is as today.
- **Hook-spawned processes.** `launchctl` is spawned from the tick, not from a git hook; say so in the PR body (AISDLC-1129 does not apply).
- **Docs.** The webhook section of `docs/operations/cli-hierarchy.md` describes the repair step, its limits and when a decision is still opened.

Out of scope: replacing `gh webhook forward` with another transport; upgrading the `gh webhook` extension; restarting the receiver process on new code (AISDLC-1272 covers it); reducing gh polling.

## Acceptance Criteria

- [ ] #1 A test with health `down` for silence and a launchd agent feed shows one `launchctl kickstart -k` call for the agent's label and an attempt recorded in the health state; no decision is opened at that tick.
- [ ] #2 A test shows no more than 3 kickstarts in 60 minutes and none within 5 minutes of the previous one; when the limit is reached a decision is opened whose body lists the attempts and the redacted log tail.
- [ ] #3 A test with an agent job that is loaded but not running (the AISDLC-1285 "loaded is not running" reading) triggers the repair step even when no pull request changed.
- [ ] #4 A test with an installed agent file that differs from the current shape and the secret set reinstalls it; with the secret unset it makes no `launchctl` call and opens the decision with the stated reason.
- [ ] #5 A test puts `--secret abc123` and `AI_SDLC_WEBHOOK_SECRET=abc123` in the log tail and asserts `abc123` appears nowhere in the decision body or the health state file.
- [ ] #6 An arriving event resets the attempt count and closes the open webhook decision as today; a test asserts both.
- [ ] #7 `cli-hierarchy webhook status` prints `loaded, not running (last exit 126)` for such a job; a test asserts the text.
- [ ] #8 With a feed of kind `tunnel` or `none`, or on a platform without launchd, the step makes no `launchctl` call; a test asserts it.
- [ ] #9 `docs/operations/cli-hierarchy.md` describes the repair step.
- [ ] #10 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
