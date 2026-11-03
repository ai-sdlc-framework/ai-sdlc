---
id: AISDLC-1175
title: 'DoR upstream-OQ scanner treats prose that starts with an OQ id as a question, and cli-dor-check prints an empty gate list for an upstream-only refusal'
status: To Do
assignee: []
created_date: '2026-11-03'
labels:
  - dor
  - pipeline-cli
  - bug
dependencies: []
references:
  - pipeline-cli/src/dor/upstream-oq-gate.ts
  - pipeline-cli/src/dor/upstream-oq-gate.test.ts
  - pipeline-cli/src/cli/dor-check.ts
  - pipeline-cli/src/dor/comment-loop.ts
priority: high
dispatchable: true
---

## Description

**Five-step review (requirements first).**
1. Question the requirement: the upstream-OQ gate (AISDLC-296) must count the questions in an RFC's Open Questions section, not every line that starts with an OQ id. A refusal must name its reason.
2. Delete: nothing to delete.
3. Simplify: the scanner recognises a question by its heading form only; the CLI prints one reason string.
4. Accelerate: no change.
5. Automate: covered by unit tests.

**Observed 2026-11-03.** Filing AISDLC-1168 to 1174 against RFC-0061 (Signed Off, all eight OQs carrying a `**Resolution:**` block) was refused. Two defects combined:

1. `findUnresolvedOqs` in `upstream-oq-gate.ts` splits the section with `OQ_QUESTION_RE`, which matches any line that starts with `OQ-<n>` followed by whitespace. The preamble sentence `OQ-8 was walked first because it bounds OQ-1 and OQ-4.` became a ninth block with no resolution marker, so `unresolvedOqCount` was 1. PR #2322 reworded the sentence as a workaround.
2. `checkOneTaskFile` in `dor-check.ts` renders `renderClarificationComment(result.verdict)` when `shouldRefuseExecution` is true. When the seven-gate verdict is `admit` and only `upstreamOqCheck.rejected` is true, the comment header says "blocked on the following gates" and lists none. `upstreamOqCheck.rejectionSummary` already holds the reason and is never printed. `cli-file task` relays that empty comment.

**Fix.**
- The scanner only treats a line as a question heading when it is a Markdown heading (`#{1,6} `), an ordered-list item, or a bold-wrapped `**OQ-n ...**` line; a plain prose line that happens to start with `OQ-n` is body text of the preceding block, or preamble when it precedes the first heading. Preamble text before the first question heading is never a block.
- `cli-dor-check` and `cli-file task` print `upstreamOqCheck.rejectionSummary` (and the per-RFC `unresolvedOqSample`) whenever `upstreamOqCheck.rejected` is true, before any gate comment, and omit the gate comment when no gate failed.

**Out of scope:** changing what counts as a resolution marker; the inline `✅ **RESOLVED**` heading form stays as is.

## Acceptance Criteria

- [ ] AC-1: `findUnresolvedOqs` returns `[]` for an RFC whose Open Questions section has a preamble line starting with `OQ-8 ...` followed by eight `### OQ-n` headings each with a `**Resolution:**` block. Unit test with the RFC-0061 preamble text verbatim.
- [ ] AC-2: `findUnresolvedOqs` still returns the heading of an `### OQ-n` block with no resolution marker, and still handles the inline `✅ **RESOLVED**` heading form. Existing tests stay green.
- [ ] AC-3: A prose line starting with `OQ-3` inside the body of `### OQ-2` does not create a block; `### OQ-2` is judged by its own markers. Unit test.
- [ ] AC-4: `cli-dor-check --task <file>` on a task referencing an RFC with one unresolved OQ and no failing rubric gate prints the RFC id, the count and the sample heading, and does not print "blocked on the following gates" with an empty list. Test on the CLI function.
- [ ] AC-5: `cli-file task` relays the same reason text in its `refused: DoR:` line. Test.
