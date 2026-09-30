---
id: AISDLC-661
title: >-
  Harden the follow-up gate against fence, long-heading and embedded-marker bypasses
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - capability-liveness
  - backlog
  - hooks
dependencies: []
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/backlog/followup-rule.ts
  - ai-sdlc-plugin/mcp-server/src/tools/task-complete.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The follow-up gate shipped with RFC-0049 section 9.5 is a hygiene check, and the
security review of that change found four ways past it that were judged acceptable
for the first version. Each lets prose sit under a `Follow-up` heading without being
checked. Close them so the gate's claim that every follow-up is tracked holds.

1. **Fence detection.** `fenceOpen()` accepts more fences than CommonMark does: any
   indentation (CommonMark: four or more spaces is an indented code block) and a
   backtick opener whose info string contains a backtick. Such a line opens a fence in
   the checker but renders as inline or indented code, so a heading after it is never
   checked. Accept only zero to three spaces of indent and reject backtick openers
   with a backtick in the info string.
2. **Heading line skipped.** The outer scan drops lines over the length cap before
   testing for a Follow-up heading, and splits only on `\n` and `\r\n`. A heading
   padded past the cap, or one ended by a bare carriage return, hides the section.
   Report an over-long line that starts like a Follow-up heading as a violation, and
   split on `\r\n`, `\r` and `\n`.
3. **Embedded end marker.** A `finalSummary` passed to `task_complete` can contain its
   own Final Summary end marker in the middle of the Follow-up section, so the check
   stops there while the text after it still renders under the heading. In the
   `task_complete` path, reject any section marker in the input (Backlog.md adds the
   markers itself), or honour the end marker only when checking a whole task file.
4. **Unclosed outer fence.** An unclosed fence before the heading hides the section.
   Fail closed: when the document ends inside a fence and a Follow-up heading line
   appeared inside it, report a violation.

Design source: `spec/rfcs/RFC-0049-system-one-judgment-layer.md`, section 9.5. Do not
edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] A Follow-up heading after a line that is an indented code block or inline code in CommonMark is still checked.
- [ ] An over-long heading line and a bare-carriage-return heading line are reported, not skipped.
- [ ] `task_complete` rejects a `finalSummary` that contains a section marker, and still accepts the same summary without it.
- [ ] A document that ends inside a fence containing a Follow-up heading is reported.
- [ ] Each case above has a test, and the existing follow-up gate tests still pass.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
