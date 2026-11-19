---
id: AISDLC-1320
title: 'Upstream open-question gate counts only open question entries and its refusal lists each with file and line'
status: In Progress
assignee: []
created_date: '2026-11-18'
labels:
  - dor
  - governance
dependencies: []
references:
  - pipeline-cli/src/dor/upstream-oq-gate.ts
  - pipeline-cli/src/dor/upstream-oq-gate.test.ts
  - pipeline-cli/src/cli/dor-check.ts
  - pipeline-cli/src/cli/dor-check.test.ts
  - docs/operations/dor-ingress-gate.md
priority: high
dispatchable: true
dispatchableReason: "Operator order of 2026-11-18: 'file a gate fix first, then the two docs tasks'."
---

## Description

**Gap.** The upstream open-question gate (AISDLC-296) counts list items that are not open questions, so it refuses a task that references a finished RFC, and its refusal text does not let a reader check the count.

What was seen on 2026-11-18, running `node pipeline-cli/bin/cli-dor-check.mjs --task <draft>` on two drafts (AISDLC-1316 and AISDLC-1317, both about RFC docs and status):

- The RFC on tessellated design-intent documents (lifecycle `Implemented`, file under `spec/rfcs/`) was refused with "3 unresolved OQ(s)". The three counted lines (lines 948 to 950 of the file) are the numbered trigger checklist inside the resolution of its question OQ-11: "Regulatory hard requirement", "Customer contract", "Operator security review". The question itself carries `[RESOLVED 2026-05-04 ...]` in its heading and a `**Resolution ...**` paragraph. Every one of its other questions is resolved. Nothing in that file is open.
- The RFC on the decision catalog (lifecycle `Implemented`, file under `spec/rfcs/`) was refused with "8 unresolved OQ(s)". The eight counted lines (lines 584 to 598) are the numbered list of design patterns in sub-section 15.1, which sits inside the Open Questions section but is not a question. All 14 questions above it (lines 520 to 582) carry a `**Resolution (2026-05-15):**` marker.
- The refusal printed the first three items cut to about 120 characters and no file or line, so the operator had to open each RFC and search to see what was counted.

**Cause (read from the source).**

- `findUnresolvedOqs` (`pipeline-cli/src/dor/upstream-oq-gate.ts:369`) takes the text of the Open Questions section up to the next heading of the same or a shallower level (`:377-379`). A `###` sub-section therefore stays inside it.
- Inside that text, `isQuestionHeading` (`:340-345`) starts a new question at every line that is a Markdown heading, an ordered-list item (`1. `) or a bold line whose text matches `OQ_QUESTION_RE` (`:333`). The loop at `:387-393` starts a new block at each such line, in any position.
- A block is "resolved" only when the marker regexes (`:351-356`) match inside the block (`:404-410`). A numbered list item inside a resolved question, or a numbered list under a non-question sub-heading, starts a block of its own that has no marker, so it is counted.
- `checkRfc` (`:422-461`) treats an RFC as rejected when the lifecycle is `Draft` or `Ready for Review` or when that count is above zero. The lifecycle `Implemented` is allowed (`:44`) but the count is checked regardless, as the comment at `:64-67` says is intended. The lifecycle is not the cause here.
- The refusal is built in `buildRejectionSummary` (`:611-631`) from `unresolvedOqSample`, the first five headings cut to 120 characters (`:450`), of which three are printed (`:621`). `dor-check.ts:114` prints the same cut list. Neither carries a file path or a line number.

**Shape.** An entry is counted only when it is an open question: a question heading, or a numbered or bold question item that is directly in the Open Questions section. A numbered or bulleted list that sits inside a question, or under a sub-heading that is not a question, is part of that text and is not counted. Each counted entry is printed with the file and line.

**Control.** What is counted as resolved does not change: the marker regexes at `:351-356` stay as they are, so a question without a marker is still counted. The lifecycle rule, `blocked.reason`, `assumes:` and `requires:` handling, and which RFCs a task references (`:494-524`) do not change. The gate does not start to skip an RFC because of its lifecycle; that is a separate decision and not part of this task.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "count every numbered line in the Open Questions section" was set in AISDLC-296 (and widened in AISDLC-1175) to find questions written as numbered items; no decision asks for list items inside a resolution or under a design-notes sub-heading to be counted, and the gate's own header says it counts questions. 2. Deleted: the rule that every ordered-list line anywhere in the section starts a question block. 3. Simplified or optimised: one rule for where a question starts: a heading-form question owns every line up to the next question heading, and a sub-heading that is not a question ends the question list; the refusal prints the counted lines themselves instead of a cut sample. 4. Accelerated: a task that references a finished RFC is no longer refused and then overridden by hand with `blocked.reason`, which skips the gate for every RFC the task names. 5. Automated: nothing new; the existing `cli-dor-check` run prints the evidence.

- **Question scan.** In `findUnresolvedOqs` (`upstream-oq-gate.ts`):
  - after a question that starts with a Markdown heading (`### OQ-3 ...`), numbered lines below it are text of that question until the next heading;
  - a Markdown sub-heading that is not a question (for example `### 15.1 Design Patterns`) ends the question list; numbered lines below it are not counted until a later question heading;
  - a section whose questions are numbered items directly under `## Open Questions` (`1. **Title.** ...` followed by a `**Resolution ...**` paragraph) is scanned as it is now.
- **Entry shape.** Return, for each counted entry, its 1-based line in the RFC file and its heading text, in a new function used by `checkRfc`. `findUnresolvedOqs` may stay as a thin wrapper if other code or tests use it; delete it if nothing does (dark-code gate).
- **Refusal text.** `RfcOqCheckResult` carries the RFC file path (relative to the repository root) and the list of `{ line, text }` for every counted entry. `buildRejectionSummary` and the comment lines at `dor-check.ts:111-114` print `<file>:<line>: <text>` for each entry. Text is cut at 120 characters; the list is cut after 20 entries with "and N more" (N exact). The count printed equals the number of entries.
- **Refusal names the `assumes:` option.** Every upstream refusal, whether on open questions or on the lifecycle of the referenced RFC, ends with one fixed sentence: a task that only names the RFC and does not depend on its design being settled lists the RFC under `assumes:` in its frontmatter, which the gate never refuses (AISDLC-311); a task that builds on the RFC waits for it. The same sentence is in the comment printed by `dor-check.ts`. The behaviour of `assumes:`, `requires:` and `references:` is unchanged. Operator order of 2026-11-18: "add the assumes option to the refusal text".
- **Docs.** In `docs/operations/dor-ingress-gate.md`: state what is counted (an open question entry), what is not (a list inside a question or under a non-question sub-heading), and the format of the refusal line.
- **Stop rule.** If running the scan over every file in `spec/rfcs/` shows a count that changes for an RFC other than the two named in the Description, stop and report which RFC and which lines in the verdict notes; do not widen the rule to make the numbers match.

Out of scope: skipping RFCs by lifecycle; the marker regexes; treating a checkmark entry as resolved (some RFCs list questions with a check mark and no `Resolution` word; they stay counted); the task-reference extraction; any edit to a file under `spec/rfcs/`; the lifecycle refusal of an RFC at `Ready for Review`.

## Acceptance Criteria

- [ ] #1 A fixture test in `upstream-oq-gate.test.ts`: a `### OQ-11` question whose resolution contains a numbered three-item checklist and a `**Resolution ...**` marker yields zero counted entries.
- [ ] #2 A fixture test: an Open Questions section with resolved numbered questions followed by `### 15.1 Design Patterns` and a numbered list of eight items yields zero counted entries.
- [ ] #3 A fixture test: the same section with one numbered question that has no marker yields exactly one entry, with its correct line number, and the design-pattern list under the sub-heading still adds none.
- [ ] #4 The existing tests for a plain numbered question list, a `### OQ-n` question list, `RESOLVED:` markers, the inline marker on a heading line and a question without a marker pass unchanged.
- [ ] #5 A test reads the two real RFC files that were refused, found under `spec/rfcs/` by glob on the words `tessellated-design-intent` and `decision-catalog-operator-routing`, and expects zero counted entries for each. It does not name the files by number.
- [ ] #6 A test runs the scan over every RFC file under `spec/rfcs/` and compares the count per file with a list written into the test of files whose count is above zero (today: draft and review RFCs with real open questions, and one `Implemented` RFC whose four questions are marked with a check mark only). A change in any count other than the two named in #5 fails the test.
- [ ] #7 A test of the refusal text: for a fixture RFC with three open questions, the message names the RFC file path and a `:<line>:` for each of the three, and the printed count is 3. For a fixture with 25, the message lists 20 and ends with "and 5 more".
- [ ] #8 `node pipeline-cli/bin/cli-dor-check.mjs --task <file>` on a task that references the two RFCs of #5, run on a copy of the repository tree at the fix commit, no longer prints an upstream-OQ refusal for either. The test of `dor-check.ts` covers the new comment lines.
- [ ] #9 `docs/operations/dor-ingress-gate.md` states the counting rule and the `<file>:<line>: <text>` form.
- [ ] #10 The diff changes no file under `spec/rfcs/` and no marker regex, and `BLOCKED_LIFECYCLES` and `ALLOWED_LIFECYCLES` are unchanged.
- [ ] #11 A test of the refusal text: a refusal on open questions and a refusal on lifecycle `Ready for Review` each contain the word `assumes:` and the sentence that says when to use it; a task that lists the same RFC under `assumes:` is not refused (existing behaviour, asserted in the same test). `docs/operations/dor-ingress-gate.md` shows the sentence.
- [ ] #12 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
