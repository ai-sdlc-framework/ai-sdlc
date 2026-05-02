---
id: AISDLC-127
title: >-
  Apply secret redaction upstream of comment-loop ingress (block leak path back
  to GitHub issue)
status: Done
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
- [x] #1 Identify all egress paths from `evaluateIssueE2E()` that write verdict text outside the calibration log (comment-loop ingress, Slack digest, dashboard, _events.jsonl, etc.)
- [x] #2 Apply redactSecrets() at every identified egress path, OR move redaction into evaluateIssueE2E() return so all consumers receive redacted strings by default
- [x] #3 Add a test that simulates an LLM clarificationQuestion echoing a fake token and asserts the GitHub-posted comment is redacted
- [x] #4 Update redactVerdict() docstring in calibration-log.ts to reflect the new contract (no longer documents the unredacted-verdict consumer pattern as 'fine')
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Outcome: SUBSUMED by AISDLC-115.4 + this docstring fix

**AC #1 (identify egress paths)**: comment-loop ingress identified as the operative path. Future surfaces (Slack digest per RFC-0011 Phase 5, observability events per RFC-0015 §7) don't exist yet — when they ship, they MUST follow the same pattern (documented in `redactVerdict()` docstring).

**AC #2 (apply redactSecrets at egress)**: shipped via AISDLC-115.4 (PR #160). `comment-loop.ts` `renderClarificationComment` / `renderAdmitComment` / `renderPrTasksComment` all call `redactSecrets()` on every author-derived field (finding, clarificationQuestion, summary, questions). The `dor-render-comment` + `dor-render-pr-summary` CLI subcommands wrap these renderers; the GH Action workflow `dor-ingress.yml` calls them via env-var-passed body so the same guarantee applies on the workflow path.

**AC #3 (test asserting GitHub-posted comment is redacted)**: shipped via AISDLC-115.4. `pipeline-cli/src/cli/index.test.ts` constructs a fake `sk-ant-api03-` token via template-literal concat (avoids GH secret-scanning) and asserts the rendered subcommand output contains `[REDACTED:ANTHROPIC]` instead of the raw token.

**AC #4 (update redactVerdict() docstring)**: closed by THIS commit. Old docstring claimed "callers can keep their unredacted copy for in-memory consumers (e.g. comment-loop ingress that posts the clarifying question back to GitHub before the redaction layer cares)" — that consumer pattern is no longer "fine" because the comment-loop now redacts at its own egress. New docstring inverts the contract: "every egress path MUST apply its own redactSecrets() pass" + cites the comment-loop + future-surface obligations.

## Verification
- comment-loop renderers verified to call redactSecrets on finding/clarificationQuestion/summary/questions (`grep -n redactSecrets pipeline-cli/src/dor/comment-loop.ts`)
- subcommand redaction tests verified at `pipeline-cli/src/cli/index.test.ts` lines 177, 209, 235, 259
- Updated docstring lints + builds clean
<!-- SECTION:FINAL_SUMMARY:END -->
