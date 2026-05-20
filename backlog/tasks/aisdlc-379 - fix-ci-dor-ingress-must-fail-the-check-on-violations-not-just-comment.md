---
id: AISDLC-379
title: 'fix(ci): DoR ingress workflow must FAIL the status check on violations (not just post a comment)'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - ci
  - dor
  - bug
  - critical
dependencies: []
priority: critical
references:
  - .github/workflows/dor-ingress.yml
  - pipeline-cli/src/dor/ingress-claude.ts
---

## Problem

The DoR ingress CI workflow (the `Evaluate backlog tasks changed by PR` check) currently:

1. Detects DoR violations in changed task files
2. Posts a `<!-- ai-sdlc:dor-comment -->` comment on the PR
3. **Exits 0** — the status check is SUCCESS regardless of how many violations were posted

Result: a PR with multiple Gate 3 (unresolved-reference) violations across 5 task files looked CLEAN in the merge state and was auto-mergeable. The DoR feedback was informational-only, not blocking.

**2026-05-20 incident** — PR #573 (RFC-0041 task breakdown) hit Gate 3 violations on every task file but `Evaluate backlog tasks changed by PR` returned SUCCESS. State CLEAN. Auto-merge armed. The whole point of the DoR gate (per AISDLC-296) was to refuse-or-fix at the boundary, not to passively log violations.

## Fix (single PR)

### A. Make the workflow exit non-zero on violations

In the `.github/workflows/` DoR ingress workflow, after the existing comment-post step, add:

```yaml
- name: Fail check on unresolved violations
  if: steps.dor_eval.outputs.has_violations == 'true'
  run: |
    echo "::error::DoR violations detected in staged backlog task changes. See PR comment for details."
    echo "::error::Fix the offending task body or set blocked.reason in frontmatter; push to re-evaluate."
    exit 1
```

`steps.dor_eval.outputs.has_violations` is set by the existing evaluation step (computed internally; expose as a workflow output).

### B. Branch protection update

Add `Evaluate backlog tasks changed by PR` to required status checks via:

```bash
gh api -X PATCH repos/ai-sdlc-framework/ai-sdlc/branches/main/protection/required_status_checks \
  -F 'contexts[]=Backlog Drift' \
  -F 'contexts[]=ai-sdlc/pr-ready' \
  -F 'contexts[]=ai-sdlc/attestation' \
  -F 'contexts[]=Evaluate backlog tasks changed by PR'
```

Ship the helper script under scripts/ so the change is reproducible if branch protection is recreated.

### C. Operator override path

Tasks with `blocked.reason` in frontmatter already bypass the DoR gate per the AISDLC-296 extension to the rubric. The fail-loud workflow honors this — if every staged task has blocked.reason, has_violations stays false and the check passes. Document the override in a new dor-gate operator doc under docs/operations/.

### D. Hermetic test for the workflow

A test fixture under .github/workflows/__tests__/ that simulates:
- Clean PR (no violations) → check passes
- PR with violations on a task that has blocked.reason → check passes (override honored)
- PR with violations on a task WITHOUT blocked.reason → check fails with exit 1

## Acceptance criteria

- [ ] #1 DoR ingress workflow exits non-zero when violations exist in any staged task without blocked.reason
- [ ] #2 has_violations exposed as a workflow output (currently computed internally only)
- [ ] #3 Branch protection updated to require Evaluate backlog tasks changed by PR; helper script committed
- [ ] #4 a new dor-gate operator doc under docs/operations/ updated with the blocked.reason override mechanic
- [ ] #5 Hermetic test fixture under .github/workflows/__tests__/ covers clean / override / fail branches
- [ ] #6 Verified by opening a test PR with intentional DoR violations → merge blocked, unblocks only when task body fixed
- [ ] #7 New code reaches 80%+ patch coverage

## Out of scope

- Pre-push hook tightening (separate task AISDLC-378)
- Changing what counts as a violation (the existing seven-point rubric gates remain authoritative)
- Auto-fixing DoR violations (separate idea; LLM-driven)

## Source

Operator 2026-05-20 frustration during RFC-0041 task breakdown: "shouldn't this be a gate" — referring to the DoR ingress workflow that posts a comment but doesn't block merge. Confirmed by inspecting PR #573 check rollup: Evaluate backlog tasks changed by PR returned SUCCESS despite posting a 5-task violations comment.
