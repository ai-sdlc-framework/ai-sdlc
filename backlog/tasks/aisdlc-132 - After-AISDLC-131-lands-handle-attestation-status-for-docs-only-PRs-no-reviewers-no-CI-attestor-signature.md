---
id: AISDLC-132
title: >-
  After AISDLC-131 lands: handle attestation status for docs-only PRs (no
  reviewers = no CI-attestor signature)
status: To Do
assignee: []
created_date: '2026-05-02 00:42'
labels:
  - ci
  - infrastructure
  - attestation
  - follow-up
milestone: m-3
dependencies:
  - AISDLC-131
references:
  - .github/workflows/verify-attestation.yml
  - .github/workflows/ai-sdlc-review.yml
  - scripts/ci-sign-attestation.mjs
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Side effect of AISDLC-131**: once `ai-sdlc-review.yml` skips reviewer fan-out for docs-only PRs (RFC drafts, backlog tasks, READMEs), the CI-side attestor (`scripts/ci-sign-attestation.mjs`) ALSO won't fire — it gates on "all 3 reviewers approved." Result: docs-only PRs would show `ai-sdlc/attestation: missing` or `invalid`, blocking merge despite no actual code review needed.

**Verified state**: `scripts/ci-sign-attestation.mjs` (line 357 area, AC #4 hard-stop) refuses to sign unless every reviewer approved. With AISDLC-131's `paths-ignore`, the analyze job is skipped → no verdicts → attestor refuses → status check fails.

**Two options to fix** (decide in PR review):

**A. Waive the attestation requirement for docs-only PRs** — `verify-attestation.yml` adds the same `paths-ignore` as `ai-sdlc-review.yml`. Status check just doesn't post for docs-only PRs; branch protection should treat it as N/A.

**B. CI-side attestor signs unconditionally for docs-only PRs** — modify the workflow to detect "docs-only changeset" (same paths-ignore predicate) and sign a special envelope marked `signedReason: 'docs-only-no-review'` that the verifier accepts as a valid alternative to reviewer-approval signing. Threat model: docs PRs can still be reviewed by humans (CODEOWNERS); the attestation just records "no agent review needed."

**Recommendation**: A (simpler). The attestation gate exists to ensure code changes were reviewed; docs changes aren't code, so the gate doesn't need to fire. B preserves the "every PR has an attestation" invariant but at the cost of yet another envelope variant + verifier path.

**Sequencing**: this task is BLOCKED on AISDLC-131 landing (no point fixing the side effect before the cause). When 131 ships, immediately file/dispatch this one — likely a 1-line workflow `paths-ignore` if Option A.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Decide A vs B with rationale documented in the PR body
- [ ] #2 If A: `verify-attestation.yml` adds the same paths-ignore as ai-sdlc-review.yml (covering spec/rfcs/**, docs/**, backlog/tasks/**, backlog/completed/**, root *.md)
- [ ] #3 If B: ci-sign-attestation.mjs detects docs-only changesets + signs with `signedReason: 'docs-only-no-review'`; verifier accepts; new envelope variant documented in CLAUDE.md
- [ ] #4 Verify behaviour: open a docs-only test PR after both AISDLC-131 + this task land. Confirm `ai-sdlc/attestation` is either N/A (Option A) or SUCCESS with the docs-only reason (Option B). PR mergeable without manual intervention.
- [ ] #5 CLAUDE.md updated under 'Review attestations → CI behavior' to document the docs-only path
<!-- AC:END -->
