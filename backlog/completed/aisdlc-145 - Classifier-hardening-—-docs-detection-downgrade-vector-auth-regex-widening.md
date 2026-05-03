---
id: AISDLC-145
title: Classifier hardening — docs-detection downgrade vector + auth regex widening
status: Done
assignee: []
created_date: '2026-05-02 22:35'
labels:
  - follow-up
  - review
  - security-low
dependencies:
  - AISDLC-141
references:
  - pipeline-cli/src/classifier/classifier.ts
priority: medium
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists: orchestrator/src/models/classifier.ts
      (also has copy)
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Security reviewer flagged 2 LOW findings on AISDLC-141's classifier ruleset. Both are downgrade vectors (skip security review when shouldn't), not exploitable bypasses, but worth hardening since the whole point of the classifier is to scope review depth correctly.

## Fix 1: docs-branch must require docs-like extensions (not just docs/ prefix)
**Current behavior:** `p.startsWith('docs/')` matches ANY file under docs/. So `docs/install.sh`, `docs/.env`, `docs/auth-spec.ts`, `docs/Dockerfile`, `docs/private-key.pem` all classify as docs-only → security reviewer skipped.

**Fix:** in the docs-prefix branch, require extension in `{md, rst, txt, png, jpg, svg, gif, ico, pdf}`. Additionally denylist `.env*`, `*.pem`, `*.key`, `*.sh`, `Dockerfile*`, `*.lock` from the docs branch unconditionally.

## Fix 2: widen auth-detection regex
**Current behavior:** `/(?:^|/)(auth|crypto|secrets?)\b/i` — misses `oauth/`, `iam/`, `permissions/`, `jwt/`, `session/`, `login.ts`, `rbac/`, `tokens.ts`. These fall through to the default branch (all 3 reviewers + confidence 0.8) — not skipped, but they don't get the opus model bump or 0.99 confidence pin.

**Fix:** widen regex to include `oauth|iam|jwt|session|login|rbac|tokens|credentials|password|signin|signup`. Also widen lockfile regex (`Gemfile.lock`, `composer.lock`, `go.sum`, `bun.lockb`) and CI regex (`.circleci/`, `.gitlab-ci.yml`, `Jenkinsfile`, `azure-pipelines.yml`).

## ⚠ Two-copy concern
The classifier exists in BOTH `pipeline-cli/src/classifier/classifier.ts` AND `orchestrator/src/models/classifier.ts` (AISDLC-141 documented this duplication for tier inversion). Both copies must be updated together. Future cleanup task could collapse the duplication.

## Acceptance criteria
1. docs-branch requires extension in safe-list; denylist enforced
2. Auth regex widened to cover oauth/iam/jwt/session/rbac/etc.
3. Lockfile + CI regexes widened
4. New tests: malicious docs/install.sh → all 3 reviewers (not just critic); src/oauth/ change → all 3 + opus bump
5. BOTH copies updated together (pipeline-cli + orchestrator)
6. ≥80% patch coverage maintained</description>
<acceptanceCriteria>["docs-branch requires extension in {md,rst,txt,png,jpg,svg,gif,ico,pdf}", "Denylist enforced: .env*, *.pem, *.key, *.sh, Dockerfile*, *.lock", "Auth regex widened: oauth|iam|jwt|session|login|rbac|tokens|credentials|password|signin|signup", "Lockfile regex widened: Gemfile.lock, composer.lock, go.sum, bun.lockb", "CI regex widened: .circleci/, .gitlab-ci.yml, Jenkinsfile, azure-pipelines.yml", "Tests for downgrade-vector PRs (docs/install.sh -> all 3; src/oauth/ -> opus bump)", "BOTH copies updated together (pipeline-cli + orchestrator)", ">=80% patch coverage"]</acceptanceCriteria>
</invoke>
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Closed AISDLC-141's 2 LOW security findings: (1) docs-branch now requires extension in safelist + denies executable/secret-looking filenames; (2) auth regex widened to cover oauth/iam/jwt/session/login/rbac/tokens/credentials/password/signin/signup + .env/.pem/.key files. Plus widened lockfile (Gemfile.lock, composer.lock, go.sum, bun.lockb) and CI (.circleci/, .gitlab-ci.yml, Jenkinsfile, azure-pipelines.yml). Both classifier copies updated together.

## Verification
- 3 reviews APPROVED — 0c/0M/3m/3s
- 8 task-pinned scenarios all assert correctly: docs/install.sh → all 3; docs/.env → all 3 + opus; docs/architecture.md → critic only; src/oauth/ → all 3 + opus; src/jwt/tokens.ts → all 3 + opus; src/iam/permissions.ts → all 3 + opus; Gemfile.lock → security+critic; .gitlab-ci.yml → security+critic
- 50/50 orchestrator + 49/49 pipeline-cli classifier tests pass
- Both copies updated together (no drift)

## Follow-up (deferred)
- Test-reviewer minor: pipeline-cli has extra docs/auth-spec.md test (line 369) the orchestrator copy lacks despite "mirror" claim — sync the two
- Code-reviewer minor: pipeline-cli classifier.test.ts:369 it() title says "falls to all-3 because auth regex outranks docs branch" but assertion expects ['critic'] (docs branch DOES win) — rename for accuracy
- Auth regex \\b false negatives: src/passwordless/, src/authentication/, src/sessions/ miss opus bump but still get all 3 reviewers via default branch (acceptable per security review)
- Long-term: extract shared @ai-sdlc/classifier-ruleset package to eliminate the duplication
<!-- SECTION:FINAL_SUMMARY:END -->
