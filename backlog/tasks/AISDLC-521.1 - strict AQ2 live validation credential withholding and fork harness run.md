---
id: AISDLC-521.1
title: 'Strict AQ2 live validation: credential-withholding proof against the live container, benign fork-PR end-to-end on the fork harness, and the agentic-reviewer path note (operator-gated)'
status: To Do
assignee: []
created_date: '2026-11-08'
labels:
  - sandbox
  - rfc-0043
  - security
  - operator-gated
dependencies:
  - AISDLC-521
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - backlog/tasks/aisdlc-521 - feat-RFC-0043-strict-aq2-in-container-reviewers-enable-agentic.md
priority: medium
dispatchable: false
dispatchableReason: 'Operator-gated: AC 1 needs a live container under AI_SDLC_SANDBOX_INTEGRATION on a machine with Docker, and AC 2 needs a loop-gated live run on the fork harness ai-sdlc-enterprise/ai-sdlc-ucvg-test. Split out of AISDLC-521 by operator ruling 2026-11-08 (decision rubric) so the hermetic scope can land without an executor stalling on these.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-521 lands the strict AQ2 shape with hermetic tests: reviewers execute inside the sandbox container, the network is a proxy-only pinhole to `inference.local`, the provider credential is never in the container, verdicts return by a mounted volume. This task is the live proof of that shape, which only the operator can run, plus the design note for agentic reviewers that containment unlocks.

Origin: AISDLC-521 AC 4, 6 and 7, moved here by operator ruling 2026-11-08 (decision rubric, option "split: hermetic now, live later"). DEC-0276 is answered `go` for the hermetic scope; this task carries the live scope.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Credential withholding proven live: under `AI_SDLC_SANDBOX_INTEGRATION` the AISDLC-513 credential-exfiltration vector runs against the live reviewer container and cannot reach the provider key or any host other than `inference.local`; the run log is attached to the PR.
- [ ] #2 A benign untrusted PR passes end-to-end on the fork harness ai-sdlc-enterprise/ai-sdlc-ucvg-test: real in-container reviewers approve and the attestation status is valid; the run URL is recorded in the PR body.
- [ ] #3 `docs/operations/` gains a short page describing the path to agentic reviewers (tools in-container) now that containment exists; no agentic tool-use is implemented.
- [ ] #4 On success, the operator records the result on AISDLC-521's PR or landing record so the strict mode can be flagged on; the flag flip itself is a separate decision.
<!-- AC:END -->
