---
id: AISDLC-1452
title: "Gate questions, decisions and RFC resolutions on a passing evidence ledger"
status: Done
priority: high
labels:
  - governance
  - decision-rubric
  - decisions
  - hooks
dependencies:
  - AISDLC-1451
references:
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/hooks/hooks.json
  - pipeline-cli/src/cli/decisions.ts
  - scripts/check-rfc-docs.mjs
---

## Description

**Five-step review (requirements first).**
1. Question: the requirement stands. Operator direction 2026-11-27 (DEC-0442) asks for the fact check to be **gated**, so a decision cannot be asked or answered on an unchecked fact. A rule only in the skill's text is the reason it is not happening today.
   - Checked: no hook matches `AskUserQuestion` (`plugin.json` PreToolUse matches only `Bash`, `Write|Edit|MultiEdit`, and the role-tools catch-all).
   - Checked: `cli-decisions add` and `answer` take no evidence argument.
   - Checked: `scripts/check-rfc-docs.mjs:1203` (`checkOqResolutionMarkers`) only finds new `**Resolution:**` markers and does not ask for evidence.
2. Delete: nothing. The ledger is the one input all three gates read.
3. Simplify: every gate calls the AISDLC-1451 checker. None has its own copy of the rules.
4. Accelerate: one ledger covers the question, the decision record and the RFC resolution for the same ref.
5. Automate: the gates refuse; they do not warn. A refusal names the failing entries.

## Acceptance Criteria
- [x] #1 **Question gate.** A PreToolUse hook on `AskUserQuestion` refuses the call unless every question carries an `Evidence: <ledger path>` line, the ledger passes the checker, and its `draftSha256` matches the question text. The hook hashes the text with the AISDLC-1451 hash, leaving out the Evidence line, so any edit after the research invalidates the ledger. The one exception is a question whose header is exactly `Preference` (naming, formatting, ordering, as the rubric defines it). That question passes and is logged to the hook log with its text. Tests in `node --test` cover: no Evidence line (refused), a failing ledger (refused), a hash that doesn't match (refused), a passing ledger (allowed), and Preference (allowed and logged).
- [x] #2 **Decision gate.**
  - `cli-decisions add` requires `--evidence <ledger>` that passes, except when the source is `subagent-escalation` (an escalation is the question, not the answer). With `--file` it copies the ledger to `.ai-sdlc/decisions/evidence/DEC-NNNN.json` in the same PR.
  - `cli-decisions answer` refuses unless the decision has a passing ledger at that path, or `--evidence` supplies one. This applies to decisions opened before this change, to operator answers, and to autonomous ones.
  - Tests cover each refusal and each path that passes.
- [x] #3 **RFC resolution gate.** `checkOqResolutionMarkers` fails a newly added Open Question resolution marker unless the same line, or the line after it, cites `Evidence: .ai-sdlc/decisions/evidence/<file>.json`, and that ledger passes and is part of the diff or already on main. Test with a fixture RFC diff.
- [x] #4 The refusal message from each gate names the failing ledger entries and the command that re-checks them (`cli-decisions evidence check`).
- [x] #5 `docs/operations/decision-authority.md` lists the three gates. The rubric skill's presentation step puts the Evidence line on every question.
- [x] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Notes
- Authority: DEC-0442. This is a tightening, so class (a).
- Planner sessions are hit first: their questions to the operator are refused until they carry a ledger. That is the intent.

## Final Summary

## Summary

Both round-1 findings are fixed. `cli-decisions answer` now reads the stored evidence ledger from the write root (the active task's worktree when run from a Pattern C parent) and falls back to the catalog root. The AskUserQuestion evidence gate now lets through the one first-run merge question in `/ai-sdlc setup`, but only on its exact `Agent merge` header and exact text, and logs it. A test ties that question to the wording in setup.md.

## Changes

- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1452/pipeline-cli/src/cli/decisions.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1452/pipeline-cli/src/cli/decisions-evidence.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1452/ai-sdlc-plugin/hooks/lib/evidence-gate.js
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1452/ai-sdlc-plugin/hooks/evidence-gate.test.mjs
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1452/ai-sdlc-plugin/commands/setup.md
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1452/docs/operations/decision-authority.md

## Design decisions

Resumed round: committed only, no push (the orchestrator pushes). Finding 1: the answer handler now checks <writeRoot>/.ai-sdlc/decisions/evidence/DEC-N.json first, then <work-dir>/... A new test sets up a Pattern C parent with AI_SDLC_ACTIVE_TASK_ID: add stores the ledger in .worktrees/t-1, and answer, run without --evidence, now passes. Finding 2: I chose a narrow exemption over changing the gate's rules. SETUP_QUESTIONS in lib/evidence-gate.js maps the header 'Agent merge' to the exact question text. That question passes without a ledger and is logged with outcome 'setup' and its text. Any other header or wording is refused, and a test covers four variants. setup.md now tells the session to use that header and exact one-line text. A test reads both from setup.md, so the gate and the command cannot drift apart. decision-authority.md documents the exemption. Reviewers should confirm that exempting this one operator-choice question is acceptable; the alternative would have been a Preference header, but merge permission is a governance control, not a preference.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 3 reviews approved (harness: code-reviewer=claude-code, test-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

(none)
