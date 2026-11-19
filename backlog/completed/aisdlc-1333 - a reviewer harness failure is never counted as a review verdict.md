---
id: AISDLC-1333
title: 'A reviewer harness failure is never counted as a review verdict'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - plugin
  - pipeline-cli
  - adopter
dependencies: []
references:
  - ai-sdlc-plugin/agents/code-reviewer-codex.md
  - ai-sdlc-plugin/agents/test-reviewer-codex.md
  - ai-sdlc-plugin/agents/agents.test.mjs
  - pipeline-cli/src/next-step/review-finalize.ts
  - pipeline-cli/src/next-step/review-finalize.test.ts
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/next-step/next-step.test.ts
  - docs/operations/reviewer-dispatch-defaults.md
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to two agent bodies, the report parser, the finalize step and its tests.'
---

## Description

**Gap.** When the Codex command line tool cannot run a review (usage limit reached, not signed in, crash, timeout, missing tool), the `-codex` reviewer agents return the normal review envelope with `approved: false` and a critical finding. The pipeline cannot tell that from a real rejection. It records a rejected verdict with a critical finding, counts it in the round, and sends the task to the developer to fix a problem that is not in the code.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-18): both `code-reviewer-codex` and `test-reviewer-codex` returned `approved: false` with a critical finding because Codex hit its usage limit ("try again at Nov 19th, 2026 12:22 PM"). The run treated both as review verdicts and repeated the developer and review rounds.

**Cause (read from the source).**

- The agents return a failure as an ordinary rejection: missing tool (`ai-sdlc-plugin/agents/code-reviewer-codex.md:120-140`), unsupported sandbox flag (`:220-232`), any non-zero exit (`:245`, same text in `test-reviewer-codex.md:256-259`), unparseable output (the major finding at `:270`). Usage limit is not named anywhere; it falls in the non-zero exit case.
- `asReport` reads only `approved`, `findings` and `summary` (`pipeline-cli/src/next-step/review-finalize.ts:47-84`), so a failure envelope and a real rejection look the same.
- `finalizeReview` pushes the report as a verdict (`review-finalize.ts:337-345`), persists its transcript and verdict, and emits a leaf for it. Only a missing report is treated as a different case, and that is also a critical finding (`review-finalize.ts:308-322`).
- A rejected round is routed to the developer by the normal iteration path (`pipeline-cli/src/next-step/next-step.ts:697-715`).
- The earlier task that made the harness a repo setting left run-time detection out of scope (`backlog/completed/AISDLC-1003 - reviewer harness default comes from a repo setting not only an env var.md`), so nothing detects it today. `docs/operations/reviewer-dispatch-defaults.md:36-44` lists the cases where an operator should set the override, and does not mention a failure that happens mid-run.

**Shape.** A reviewer that could not run says so in a distinct envelope: `{ "harnessFailed": true, "reason": "<one line>", "retryAfter": "<text or null>" }`, with no `approved` and no findings. The report parser keeps that flag. `finalizeReview` treats such a report as no verdict at all: nothing is persisted for it, no leaf is emitted, no ledger row is written, no finding is counted and no developer round is started. The round asks for that reviewer's report again through the existing capped retry path. When the cap is reached the run stops with a reason that names the reviewer, the harness, the reason and the retry time, and says the review did not run. A reviewer that returns `harnessFailed` can never produce an approval.

**Control.** No control changes. The required reviewers are the same. A failed reviewer still blocks approval, now as "did not run" instead of "rejected".

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that a harness failure must look like a review result. The only reason is that the agents were given one envelope; no decision asks for it. 2. Deleted: the fake critical finding for a tool failure. 3. Simplified: one extra flag on the existing report shape, handled in the one place that turns reports into verdicts. 4. Accelerated: no developer round and no repeated review round is spent on a failure that is not in the code. 5. Automated: tests feed a failure report and a real rejection through `finalizeReview` and assert they take different paths; a test on the agent bodies asserts they name the envelope.

- **Agents.** In both `-codex` agent bodies, every case where Codex did not produce a review (not installed, sandbox flag refused, non-zero exit including a usage limit, unparseable output, timeout) returns the failure envelope with the reason and any retry time the tool printed. A real review keeps the current envelope.
- **Parser and finalize.** `ReviewerReport` and `asReport` carry `harnessFailed`, `reason` and `retryAfter`. `finalizeReview` returns a recoverable result for a failure report before it persists anything, so the existing retry path re-asks for that reviewer's report.
- **Stop reason.** When the retry cap is reached the stop reason is the one described in Shape, not the generic "not approved" text.
- **Docs.** `reviewer-dispatch-defaults.md` says what a harness failure looks like and how it differs from a rejection.
- **Tests.** In `review-finalize.test.ts` and `next-step.test.ts`; agent body check in `agents.test.mjs`.

Out of scope: choosing a different reviewer or harness when one fails (the Claude-native reviewer of the same role is already available through `AI_SDLC_REVIEWER_HARNESS` and the model routing setting; whether the pipeline switches on its own is a separate decision); detecting the limit before the round starts; the `review-executor-codex` agent.

## Acceptance Criteria

- [ ] #1 A test on `parseReviewReports` shows a `harnessFailed` report keeps its flag, reason and retry time, and a normal rejection does not get the flag.
- [ ] #2 A test on `finalizeReview` with one `harnessFailed` report and one real approval: the result is recoverable, no verdict file, transcript, leaf or ledger row is written for the failed reviewer, and the verdict list holds no entry for it.
- [ ] #3 A test shows a real rejection with a critical finding still produces a rejected verdict and goes to the developer as before.
- [ ] #4 A test on `next-step` shows a `harnessFailed` report re-asks for the reviewer's report and does not start a developer round or raise the iteration count.
- [ ] #5 A test shows that after the retry cap the run stops with a reason that names the reviewer, the harness, the reason and the retry time, and states the review did not run.
- [ ] #6 A test shows a round where every reviewer reported `harnessFailed` can never reach `APPROVED`.
- [ ] #7 A test on the agent bodies asserts both `-codex` files name the failure envelope and no longer return `approved: false` with a critical finding for a missing tool, a non-zero exit or a usage limit.
- [ ] #8 `docs/operations/reviewer-dispatch-defaults.md` describes the failure envelope and the stop reason.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
