---
id: AISDLC-127
title: >-
  Apply secret redaction upstream of comment-loop ingress (block leak path back
  to GitHub issue)
status: To Do
assignee: []
created_date: '2026-05-01 21:24'
labels:
  - security
  - rfc-0011
  - phase-2b
  - follow-up
  - architectural
milestone: m-3
dependencies:
  - AISDLC-115.4
references:
  - pipeline-cli/src/dor/calibration-log.ts
  - pipeline-cli/src/dor/composite.ts
  - >-
    backlog/completed/aisdlc-122 -
    Prevent-secret-persistence-in-DoR-calibration-log-gitignore-artifacts-and-tighten-body-inline-limits.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-122 follow-up (security minor — architectural). AISDLC-122 already merged.

`pipeline-cli/src/dor/calibration-log.ts` `redactVerdict()` docstring documents that the in-memory verdict is left unmutated "so callers can keep their unredacted copy for in-memory consumers (e.g. comment-loop ingress that posts the clarifying question back to GitHub before the redaction layer cares)."

This is the documented bypass: an LLM-derived `clarificationQuestion` that echoes a token from the body would be posted UNREDACTED back to the GitHub issue, where it lives forever in the issue comment thread.

Fix is upstream of the calibration log:
- Apply `redactSecrets()` to verdict text BEFORE the comment-loop ingress posts to GitHub, OR
- Redact earlier in `evaluateIssueE2E()` so the unredacted verdict effectively never exists at the consumer boundary

The 2nd option is cleaner but couples redaction with evaluation; the 1st keeps redaction at egress boundaries (consistent with the calibration-log layer). Implementer's call after looking at the comment-loop code (lands as part of RFC-0011 Phase 3 / AISDLC-115.4).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Identify all egress paths from `evaluateIssueE2E()` that write verdict text outside the calibration log (comment-loop ingress, Slack digest, dashboard, _events.jsonl, etc.)
- [ ] #2 Apply redactSecrets() at every identified egress path, OR move redaction into evaluateIssueE2E() return so all consumers receive redacted strings by default
- [ ] #3 Add a test that simulates an LLM clarificationQuestion echoing a fake token and asserts the GitHub-posted comment is redacted
- [ ] #4 Update redactVerdict() docstring in calibration-log.ts to reflect the new contract (no longer documents the unredacted-verdict consumer pattern as 'fine')
<!-- AC:END -->
