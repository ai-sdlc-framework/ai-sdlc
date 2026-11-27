---
id: AISDLC-1451
title: "Decision rubric verifies every fact and dependency with a research subagent before asking"
status: Done
priority: high
labels:
  - governance
  - decision-rubric
  - decisions
dependencies: []
references:
  - ai-sdlc-plugin/skills/decision-rubric/SKILL.md
  - ai-sdlc-plugin/skills/rfc-oq-walkthrough/SKILL.md
  - pipeline-cli/src/cli/decisions.ts
  - docs/operations/decision-authority.md
---

## Description

**Five-step review (requirements first).**
1. Question: the requirement stands. Operator direction 2026-11-27 (DEC-0442): unchecked facts and unverified dependencies are the biggest cause of bad decisions. Every fact, assumption and dependency path a decision rests on must be checked and verified before the question is asked or answered, so the problem is caught before it happens.
   - Checked: the AISDLC-1404 review of about 37 reversed or amended decisions put about 10 down to an unchecked or wrong fact and about 11 to an undefined record or an untested guard. Those were the two largest causes.
   - Checked: the current skill (`ai-sdlc-plugin/skills/decision-rubric/SKILL.md`, step 3) lets an **unchecked** tag reach the operator. It relies on the asking session checking its own claims, and no agent independent of the author does the checking.
   - Checked: nothing machine-readable records what was checked. `cli-decisions add` has no evidence field.
2. Delete: the **unchecked** tag as an allowed final state. "Industry research" from memory goes.
3. Simplify: one JSON evidence ledger per question, written by a research subagent, plus one checker. The gates in AISDLC-1452 all call that same checker.
4. Accelerate: the research subagent runs on Sonnet in parallel with drafting the options. A ledger that passes is reused when the decision is filed.
5. Automate: the checker re-verifies what it can (file quotes, record and task ids, paths), so a check the agent claims to have done can't simply be made up.

## Design

**The flow.**
1. The author drafts the full question: problem, options, recommendation, counter-argument and trace.
2. A research subagent gets the exact draft text. It is a separate Sonnet agent, not the author.
3. It pulls out **every** factual claim and every dependency path in the draft (records, data sources, emitters, schemas, config fields, hooks, CLIs, standards and their status and version), then checks each one at its source.
4. It writes the ledger.
5. The checker validates the ledger. Only a passing ledger lets the question be asked.

**Ledger** (`schemaVersion: 1`). Fields: `ref` (DEC-NNNN, `rfc:RFC-NNNN#OQ-N`, or a slug), `draftSha256`, `researchedBy`, `researchedAt`, `entries[]`. Each entry has an `id`, the `claim`, a `kind` and the fields below.
- **fact:** `source` is one of the following:
  - `{file, line, quote}`: re-verified, so the quote must appear at that path, within ±5 lines.
  - `{command, output, ranAt}`
  - `{url, readAt, quote}`
  - `{record}`: a DEC, RFC or task id, re-verified to exist on main.
- **dependency:** `{what, exists: {path}}`, re-verified to exist. Or `{what, prerequisite: <task id>}`, re-verified to exist as a filed task.
- **assumption:** only for a statement no source can confirm, such as a forecast or an operator preference. It carries `restsOn: [fact entry ids]` (at least one, each passing) and `falsifiedBy` (what would show it wrong). Every assumption is shown in the question.

**The checker fails the ledger when:**
- an entry is missing its source;
- an entry has any status other than checked (`unchecked`, `unverifiable` and similar all fail);
- a file quote does not match;
- a record, task or path does not exist;
- an assumption has no passing `restsOn`;
- the ledger has no entries;
- `draftSha256` does not match the draft it is checked against.

## Acceptance Criteria
- [x] #1 The rubric skill's step 3 says to send the research subagent described above, gives the exact draft and the ledger shape, and says that no question goes out until the checker passes. The **unchecked** tag is removed as a final state; anything that cannot be checked is either an assumption that rests on checked facts or a gap to close first. `rfc-oq-walkthrough` refers to the same step. Autonomous mode runs the same step.
- [x] #2 The ledger has a schema file, and `cli-decisions evidence check <ledger> [--draft <file>]` validates it as in the Design and exits non-zero on any failure, listing each failing entry. Tests cover each fail case listed under "The checker fails the ledger when", a ledger that passes, and a file quote that has drifted from the tree.
- [x] #3 `cli-decisions evidence hash <draft-file>` prints the `draftSha256` that the hook in AISDLC-1452 computes over the question text, with one normalization shared by both.
- [x] #4 `ai-sdlc doctor` checks `~/.claude/skills/` for a copy of the rubric that would shadow the plugin skill. A `decision-rubric` entry that is a symlink to a plugin `skills/decision-rubric` directory passes; the operator set this up on 2026-11-27, linking to the repo copy. Doctor warns, with the fix (replace it with that symlink), when:
  - the entry is a real directory;
  - it is a symlink to anywhere else;
  - another skill directory's `SKILL.md` declares `name: decision-rubric`. A backup left inside `skills/` still loads as a skill.

  Tests use a temp HOME and cover each case.
- [x] #5 `docs/operations/decision-authority.md` describes the ledger and says where it is stored when a decision is filed (`.ai-sdlc/decisions/evidence/DEC-NNNN.json`).
- [x] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Notes
- Authority: DEC-0442 (operator direction, 2026-11-27). The gates that enforce this are AISDLC-1452, which depends on this task.
- Interim, until both land: the planner sends a research subagent and keeps a ledger by hand before every rubric question.

## Final Summary

## Summary

Fixed the failing orchestrator test. src/runtime-gitignore.test.ts has two timing checks that make sure gitignore matching runs in linear time, and their 1000ms limit was too tight for a busy coverage run. Both limits are now 5000ms, which still fails on any non-linear scan. The ledger, checker, doctor and docs work from the earlier commit is unchanged.

## Changes

- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1451/orchestrator/src/runtime-gitignore.test.ts

## Design decisions

The failing test was not changed by this branch, and the code it tests lives in pipeline-cli. Run alone, the slash-line test takes 67ms. It failed at 1020ms against a 1000ms limit only during the loaded coverage run. A non-linear scan of 300k slashes would take far longer than 5000ms, so the check still catches a regression. I raised the other timing check in the same file, the hostile glob line test, to the same limit for the same reason. After the change, `pnpm --filter ./orchestrator test:coverage` passed (240 files, 5341 tests), and so did `pnpm build`, `pnpm test` (exit 0), `pnpm lint` and `pnpm format:check`. This was a resumed round, so I only committed: no rebase, no push, no new PR.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 3 reviews approved (harness: code-reviewer=claude-code, test-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

(none)
