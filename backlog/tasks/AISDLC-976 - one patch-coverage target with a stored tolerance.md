---
id: AISDLC-976
title: 'One patch-coverage target with a stored tolerance'
status: In Progress
assignee: []
created_date: '2026-10-20'
labels:
  - ci
  - config
dependencies: []
references:
  - scripts/check-pr-patch-coverage.mjs
  - codecov.yml
  - .ai-sdlc/review-policy.md
  - docs/operations/quality-gate.md
priority: medium
dispatchable: true
---

## Description

The patch-coverage number is stated in three places that disagree. `.ai-sdlc/review-policy.md:38` tells reviewers the CI boundary is "Line coverage on changed code (80% patch)"; `scripts/check-pr-patch-coverage.mjs:7` and `:22` default the gate to 90 (`--threshold 90`); `codecov.yml:6` and `:9` set both project and patch targets to `90%`; `docs/operations/quality-gate.md:146-163` documents the 90% gate. A reviewer reading the policy file flags coverage at a threshold the gate does not use.

Operator decision (2026-10-20): one target, 90, plus a stored tolerance of one to two points, in exactly one configuration location. The gate passes at target minus tolerance. The tolerance exists because the two measuring methods disagree by a point or two: codecov's patch computation and the script's unified-diff walk count executable lines differently, and historically local and CI runs differed too (since AISDLC-726 coverage runs only in CI, so the remaining spread is between the two methods). Fix: one key pair (for example `patchCoverage: { target: 90, tolerance: 1 }` in the `.ai-sdlc/review-policy.md` front matter, or a small yaml the script reads), `check-pr-patch-coverage.mjs` reads it as its default, `codecov.yml` is generated from it or checked against it by a test, the policy prose quotes the key instead of a literal, and `quality-gate.md` explains why the tolerance exists.

**Five-step review (requirements first).**
1. Requirement questioned: do we need a tolerance at all, or just one number? Two measuring methods that disagree by a point mean a single hard number produces reds that are measurement noise; the tolerance names that noise explicitly.
2. Delete: the three hard-coded literals (policy prose, script default, codecov targets).
3. Simplify: one key pair, one reader, one documented reason.
4. Accelerate: fewer coverage reds that are noise means fewer rerun and fix rounds.
5. Automate: a test asserts `codecov.yml` and the script default both equal the stored key, so drift cannot recur.

## Acceptance Criteria

- [ ] One configuration location holds `target` and `tolerance` for patch coverage; `check-pr-patch-coverage.mjs` reads it and passes at `target - tolerance`.
- [ ] `codecov.yml` patch and project targets equal the stored target, enforced by a test (or generated from the key).
- [ ] `.ai-sdlc/review-policy.md` and `docs/operations/quality-gate.md` cite the key, not a literal, and state why the tolerance exists.
- [ ] A test covers the tolerance arithmetic (passes at exactly `target - tolerance`, fails just below it).
