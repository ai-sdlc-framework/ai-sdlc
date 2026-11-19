---
id: AISDLC-1348
title: 'A board with no webhook feed says so, and forwarder liveness is checked for this board only'
status: In Progress
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - webhook
  - adopter
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook.ts
  - pipeline-cli/src/hierarchy/webhook.test.ts
  - pipeline-cli/src/hierarchy/webhook-forwarder.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/restart.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to the no-feed message, the forwarder liveness lookup, one status line, the help text and their tests.'
---

## Description

**Gap.** On a board with no recorded webhook feed, `up` and `restart --all` start the receiver and say nothing about the missing forwarder, so a new project never receives events and a webhook-health decision opens later. On a machine that runs several boards, the liveness check can also read another project's forwarder as this board's, so this board reports a live feed it does not have. A never-installed launchd label prints raw `launchctl` error text, and the `webhook` help leaves out two flags and the prerequisites of the feed.

What was seen in an adopter project on plugin 0.43.0 (reported 2026-11-19): three boards on one machine, with receivers on ports 8765, 8766 and 8767. The newest board had no feed installed. It got no event, and nothing at start told the operator why.

Later the same day the adopter reported that `status` on that board printed the identical `feed gh-forward` text in three different states: no forwarder at all for this board, only another repository's forwarder running, and a forwarder for this board started by hand (`gh webhook forward` aimed at this board's port 8767) that delivered events but was not recorded in the state file. Only the separate `persisted: no` line told a recorded feed from a guessed one. The third state bears on the open question below: with liveness from the record only, a working hand-started forwarder reads `feed none` while events arrive.

**Cause (read from the source).** Each fact was read on main; the link between the cause and the adopter's reading is inferred, because the adopter checkout was not available (unverified).

- `up` starts the receiver with no feed argument: `webhookUp(deps)` at `pipeline-cli/src/hierarchy/up.ts:711`. A failure prints a warning; a start with no feed prints nothing about the feed.
- `restart` does the same in two places: `webhookUp(deps)` at `pipeline-cli/src/hierarchy/restart.ts:357` (dispatch restart) and the carried-over feed at `restart.ts:381-386` (`restart --all`), where a board with no record passes `undefined`. No line says that no feed is installed.
- `forwarderSignal` (`pipeline-cli/src/hierarchy/webhook.ts:297-315`) uses the recorded agent or pid first. When the state file records neither, it runs `pgrep -f 'gh webhook forward'` (or `tunnel`) with no board scope (`webhook.ts:304-306`). Any forwarder of any project on the machine matches and returns `alive`.
- The status text then reads `feed gh-forward` for a board with no feed: `webhook.ts:357` sets `feed` to `gh-forward` whenever the forwarder is `alive`, and the status line prints it at `webhook.ts:411-412`.
- `webhookPersistence` (`webhook.ts:419-424`) calls `forwarderPersistence` (`pipeline-cli/src/hierarchy/webhook-forwarder.ts:203-217`). For a label that is not loaded it appends the first line of the `launchctl print` stderr (`webhook-forwarder.ts:213-214`, stderr captured at `:175`). A label that was never installed prints that raw text.
- The `webhook` help lists only `--port` (`pipeline-cli/src/cli/hierarchy.ts:293-294`). `--feed`, `--feed-pid` and `--feed-agent` are parsed at `hierarchy.ts:890` but are not in the help. The docs usage line at `docs/operations/cli-hierarchy.md:433` shows `--feed` and `--feed-pid`, and the paragraph at `:455-458` describes the feed, but neither names the prerequisites: the `gh webhook` extension and permission to manage hooks on the repository.

**Shape.** A board with no feed says so at `up` and `restart`, in one plain line that names the command to run. Forwarder liveness comes only from this board's own record, never from a process-name match, so another board's forwarder cannot make this board look fed. A never-installed label reads "not installed". The help and the docs list every feed flag and the two prerequisites.

**Control.** No control changes.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does the board need a guessed feed state? No; it needs this board's own record, and an operator needs to be told when there is none. 2. Deleted: the unscoped `pgrep` fallback and the raw `launchctl` stderr text. 3. Simplified or optimised: one shared helper prints the no-feed line for `up` and `restart`; nothing recorded reads as `none` through the existing path. 4. Accelerated: the operator learns at start, not after a webhook-health decision opens. 5. Automated: tests cover two boards on one machine, the no-feed line and the never-installed label.

- **No-feed line.** In `up.ts` and both `restart.ts` call sites, after the receiver start, when the recorded feed is absent (or the kind is `none`), print one line: no webhook feed is installed, events will not arrive, run `cli-hierarchy webhook up --feed gh-forward`. No line when a feed is recorded.
- **Status.** `cli-hierarchy status` shows `feed none` for a board with no record.
- **Liveness.** In `forwarderSignal`, remove the unscoped `pgrep` branch. With no recorded agent and no recorded pid, return `unknown`, and let the `feed` field read `none`. Do not add any match on a process name.
- **Persistence.** In `forwarderPersistence`, when the label is not loaded and was never installed, return `persisted: no (<label> not installed)` and print no `launchctl` text.
- **Help and docs.** Add `--feed <gh-forward|tunnel|none>` and `--feed-pid <pid>` to the `webhook` options in `hierarchy.ts` (and `--feed-agent` if it is meant for operators; see the open question). In `docs/operations/cli-hierarchy.md`, state the prerequisites next to the usage line at `:433` and the paragraph at `:455`: the `gh webhook` extension installed, and permission on the repository to create hooks.
- **Tests.** Add them in `webhook.test.ts` and `hierarchy.test.ts` (the places that already cover `webhook` and `restart`).

**Open question for the operator (not decided here).** Whether a match scoped to this board's repository and port may stand in for the record when the state file has none. Proposal only: no, record only. A scoped match is still a guess, a board that lost its record is better reported as `none`, and the self-repair and health paths already treat a recorded feed as the source of truth. A second open point on the same help text: whether `--feed-agent` is an operator flag or internal. Proposal only: leave it out of the help and name it internal, since only `webhookUp` passes it.

Out of scope: installing a feed automatically. It needs the `gh webhook` extension, a repository hook permission and a secret that only the operator holds. Also out of scope: the webhook-health reading, the decision text, the port in the fix command, and the repair steps.

## Acceptance Criteria

- [ ] #1 A test with two boards on one machine, where only the other board has a forwarder process and this board's state file records no feed, shows this board reads forwarder `unknown` and feed `none`, and no `pgrep` call is made.
- [ ] #2 A test shows `up` on a board with no recorded feed prints one line that no feed is installed and names `cli-hierarchy webhook up --feed gh-forward`, and prints no such line when a feed is recorded.
- [ ] #3 A test shows `restart --all` and a dispatch restart print the same line for a board with no recorded feed, and none for a recorded feed.
- [ ] #4 A test shows the `status` text for a board with no recorded feed contains `feed none`.
- [ ] #5 A test shows a recorded agent or pid still reads `alive` or `dead` as before.
- [ ] #6 A test shows a never-installed launchd label reads `persisted: no (<label> not installed)` and contains no `launchctl` stderr text.
- [ ] #7 A test shows the `webhook` help names `--feed` and `--feed-pid`.
- [ ] #8 The docs section for `webhook up` names the `gh webhook` extension and the repository hook permission, and the docs parity test passes.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
