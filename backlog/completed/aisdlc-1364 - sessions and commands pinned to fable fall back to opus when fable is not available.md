---
id: AISDLC-1364
title: 'Sessions and commands pinned to fable fall back to opus when fable is not available'
status: Done
assignee: []
created_date: '2026-11-21'
labels:
  - bug
  - models
  - hierarchy
dependencies: []
references:
  - ai-sdlc-plugin/commands/planner.md
  - ai-sdlc-plugin/commands/model-pins.test.mjs
  - .ai-sdlc/model-routing.yaml
  - pipeline-cli/src/routing/role-model.ts
  - pipeline-cli/src/routing/role-model.test.ts
  - pipeline-cli/src/routing/default-table.ts
  - pipeline-cli/src/routing/load-table.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/restart.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/budget.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/usage/claude-transcript.ts
  - pipeline-cli/src/usage/ingest-claude.ts
  - docs/operations/cli-hierarchy.md
  - docs/operations/agent-governance-reference.md
priority: high
---

## Description

**Gap.** When the Fable weekly limit is hit, the planner cannot be started or oriented, and nothing falls back to Opus. The operator asked on 2026-11-21: "we need a way to fallback to opus when fable isn't available".

What the operator saw (observed, not reproduced here). The weekly Fable limit was reached (it resets 2026-11-24). They ran `/model opus`, then `/ai-sdlc:planner`. Claude Code answered "You've hit your Fable limit . resets Nov 24 at 12pm (America/Vancouver)". The session default was Opus, so the command itself asked for Fable.

**Facts read in docs** (Claude Code docs, fetched 2026-11-21).

- A command or skill `model:` override applies "for the rest of the current turn"; the session model resumes on the next prompt (https://code.claude.com/docs/en/slash-commands). So the pin does not move the session to Fable. It only makes that one turn ask for Fable.
- `model:` takes "the same values as /model, or inherit". No list form is documented (same page).
- A built-in fallback exists: `--fallback-model a,b` and the `fallbackModel` setting, a chain of up to three, per turn (https://code.claude.com/docs/en/model-config, https://code.claude.com/docs/en/cli-reference). It applies when the model is "overloaded, unavailable, or returns another non-retryable server error". The same page says "Authentication, billing, rate-limit ... errors ... never trigger a switch". So a usage limit is not covered. The docs do not say whether it differs between interactive and `-p` mode: not documented.
- Fable can bill to usage credits, with a consent prompt; in `-p` mode a Fable request that would bill to credits is billed without asking (model-config page). Any fallback here must not turn into credit or `ANTHROPIC_API_KEY` billing.

**Facts read in code** (main at 8b50f3160).

- `ai-sdlc-plugin/commands/planner.md:12` is the only command or agent file with `model: fable`. Every other command and agent pins haiku, sonnet or opus (read with grep over `ai-sdlc-plugin/commands` and `ai-sdlc-plugin/agents`). So only the planner commands hit this wall; no agent does.
- `.ai-sdlc/model-routing.yaml:15` lists `strength: [haiku, sonnet, opus, fable]`. Line 109 gives role `planner` the cell `'*': { model: fable }`. Lines 13-14 say the security reviewer stays on opus or stronger.
- `ai-sdlc-plugin/commands/model-pins.test.mjs:144-155` asserts that each command and agent frontmatter `model:` equals its cell in the yaml. Nothing renders frontmatter from the yaml; the test is the check.
- `pipeline-cli/src/routing/role-model.ts:36-45` `routedModel(role)` reads the wildcard cell from the table on the base ref and falls back to a built-in default (`planner: 'fable'` at line 18). `cli/hierarchy.ts:827` uses `flags['planner-model'] ?? routedModel('planner')`, so the planner session is launched on Fable too. `docs/operations/cli-hierarchy.md:132` documents the default as `fable`.
- The launch command passes `--model <m>` to `claude` (`pipeline-cli/src/hierarchy/up.ts:278-279`), and `--planner-model` is only checked with `assertModel` (`up.ts:501`). `restart` reuses the model recorded in the roster entry (`pipeline-cli/src/hierarchy/restart.ts:230`, `:300`); it never re-resolves it. No `--fallback-model` is passed anywhere (grep).
- Limit detection exists only for accounting. `pipeline-cli/src/usage/claude-transcript.ts:111-129` classifies a notice as `usage-limit` or `rate-limit` from its text, and `ingest-claude.ts:358-363` logs it with a timestamp, session id and category. It keeps no model name and no reset time, and nothing acts on it.
- The budget pacer (`pipeline-cli/src/hierarchy/budget.ts`) reads one account-level usage endpoint (`USAGE_URL`, line 24) and keeps only `five_hour` and `seven_day` windows (lines 106-115). It has no per-model (Fable) reading. The `BUDGET` text in `status` comes from `formatBudget` (`hierarchy/status.ts:63`).

**Not found / not verified.** Whether the usage endpoint can report a per-model window: not found in code, not checked against Anthropic docs. Whether Claude Code prints the Fable limit text with a fixed shape: only the one line the operator pasted. Whether `model-pins.test.mjs` fails on a yaml cell that has no command file: not verified (needed for the design below).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: two surfaces fail for different reasons. The command pin only changes one turn, and `/ai-sdlc:planner` prints a roster and briefs and stops, so it does not need Fable; pinning it to opus removes that failure with no fallback machinery. The session model is where Fable matters and where a limit stops all work. Claude Code's own `--fallback-model` does not cover a usage limit, so it cannot be the answer. 2. Deleted: Fable as the pin of a short orientation command, and the manual `--planner-model opus` step. 3. Simplified or optimised: one fallback rule from the existing `strength` list (the next weaker model, never below the role's floor), applied in the one place that resolves a model for a launch, `routedModel`. No second table, no list in frontmatter. 4. Accelerated: the planner session starts on Opus on its own when Fable is marked unavailable, and returns to Fable when the marker expires. 5. Automated: tests cover the pin check, the resolution and the status line.

- **Command pin.** Change `planner.md:12` to `model: opus` and the yaml cell for the orientation command to opus. A command still pins a model; no `inherit`. The session role needs its own cell so the session can stay on Fable: add a `planner-session` cell (`'*': { model: fable }`) and make `routedModel('planner-session')` the launch source in `cli/hierarchy.ts:827`. The developer first confirms that `model-pins.test.mjs` accepts a cell with no command file; if not, the test is extended to skip cells listed under `launch` roles.
- **Fallback rule (one place).** `strength` in `model-routing.yaml` is the order. When a model is marked unavailable, `routedModel` returns the next weaker entry that is not below the role's floor. The security reviewer floor (opus or stronger) is a check in that function: it never resolves below opus, and a role with no allowed fallback fails loudly rather than downgrade. Fable falls back to opus. No model name or order is written in any other file.
- **Unavailable marker.** A small file in the board directory records `{ model, reason, resetsAt, since }`. It is read by `routedModel` callers at launch and expires at `resetsAt`. `up` and `restart` resolve the model through it (restart for the planner re-resolves instead of reusing the roster model when the recorded model is marked unavailable). An explicit `--planner-model` always wins.
- **Loud notice.** `status` prints one line while a fallback is active, for example `MODEL planner fable -> opus (fable limit, resets Nov 24 12:00)`, and `up` prints the same line at session start. The line is also written to the planner's launch prompt so the session itself knows.
- **Billing.** The fallback only changes the `--model` value. It never sets or reads `ANTHROPIC_API_KEY` and never accepts a Fable usage-credits prompt; a doc line states this.

Expected files (13, within the 15 file limit):

- `ai-sdlc-plugin/commands/planner.md`
- `ai-sdlc-plugin/commands/model-pins.test.mjs`
- `.ai-sdlc/model-routing.yaml`
- `pipeline-cli/src/routing/role-model.ts`
- `pipeline-cli/src/routing/role-model.test.ts`
- `pipeline-cli/src/routing/default-table.ts`
- `pipeline-cli/src/cli/hierarchy.ts`
- `pipeline-cli/src/hierarchy/up.ts`
- `pipeline-cli/src/hierarchy/restart.ts`
- `pipeline-cli/src/hierarchy/status.ts`
- `pipeline-cli/src/hierarchy/hierarchy.test.ts`
- `docs/operations/cli-hierarchy.md`
- `docs/operations/agent-governance-reference.md`

Tests go in `role-model.test.ts` (resolution, floor, expiry, explicit flag wins), `hierarchy.test.ts` (launch command carries the fallback model, status line, restart re-resolves) and `model-pins.test.mjs` (command pin equals its cell, planner-session cell allowed). If the marker writer lands in the usage ingester, its test goes in `pipeline-cli/src/usage/claude-transcript.test.ts`, and the expected files stay within 15.

Out of scope: a per-model reading of the usage endpoint, changing the budget pacer, using `--fallback-model` or the `fallbackModel` setting, and any change to agent pins.

## Open questions for the operator

**How is Fable marked unavailable?** The trace cannot settle this. The limit text carries a model name and a reset time, but the ingester keeps neither, and the docs do not describe a per-model usage reading.

- Option A: operator command, `cli-hierarchy model-down fable --until <time>`, written by hand. Simple, no parsing, but the operator must remember it.
- Option B: the usage ingester parses the limit notice (model name and reset time) and writes the marker. Automatic, but it depends on the notice text shape, which is only one observed line.
- Option C: on a failed launch (the planner window exits at once with a limit notice), `up` retries on the fallback. No detection ahead of time, but it needs a read of the window output.

Interim value the developer uses: option A, with the marker file and the loud status line, so the rule and the display are built and tested. Recommendation: A now, then B as a later task once the notice shape is confirmed; C is the weakest because it reads pane output.

**Does the orientation command stay on opus for good?** Interim value: yes, opus, because it only prints a roster and briefs. Recommendation: keep opus; the Fable pin gave no benefit for that command.

## Acceptance Criteria

- [ ] #1 `ai-sdlc-plugin/commands/planner.md` pins `model: opus`, no command or agent pins `inherit` or omits `model:`, and `model-pins.test.mjs` passes with the new cells.
- [ ] #2 A `planner-session` cell keeps the planner session on `fable`, and `cli-hierarchy up` takes its default from that cell.
- [ ] #3 When Fable is marked unavailable, a test shows `routedModel` returns `opus` for the planner session, using only the `strength` order from `model-routing.yaml`, and returns `fable` again after the marker expires.
- [ ] #4 A test shows the security reviewer never resolves below `opus`, and that a role with no allowed fallback fails with a clear error instead of downgrading.
- [ ] #5 A test shows an explicit `--planner-model` wins over the marker and the fallback.
- [ ] #6 A test shows `up` and a planner `restart` launch `claude --model opus` while the marker is active.
- [ ] #7 `status` and `up` print one line naming the role, both models, the reason and the reset time while a fallback is active, and print nothing when it is not; a test checks both.
- [ ] #8 A test shows the fallback never sets or reads `ANTHROPIC_API_KEY`, and the docs state that no usage-credit or API-key billing is chosen by the fallback.
- [ ] #9 The fallback order appears only in `model-routing.yaml` (`strength`); a grep in the pull request shows no model order written in code or docs as a second source.
- [ ] #10 The pull request body states the Claude Code facts read in the docs (turn-only `model:`, `--fallback-model` does not cover rate or usage limits) and the choice made for the open questions.
- [ ] #11 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
