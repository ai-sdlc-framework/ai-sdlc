---
id: AISDLC-122
title: >-
  Prevent secret persistence in DoR calibration log: gitignore artifacts/ and
  tighten body-inline limits
status: To Do
assignee: []
created_date: '2026-05-01 20:18'
labels:
  - security
  - rfc-0011
  - phase-2b
  - follow-up
milestone: m-3
dependencies:
  - AISDLC-115.3
references:
  - pipeline-cli/src/dor/calibration-log.ts
  - .gitignore
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#5.5
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-115.3 security follow-up (minor finding, real risk under existing pipeline policy).

`pipeline-cli/src/dor/calibration-log.ts` `resolveCalibrationLogPath()` defaults to `./artifacts/_dor/calibration.jsonl`, and the repo `.gitignore` does NOT cover `artifacts/`. `buildEntry()` inlines the full issue title and short bodies (≤500 chars) verbatim as `bodyPreview`, plus the full `RefinementVerdict` including LLM-derived `finding` / `clarificationQuestion` strings (which may quote the body).

Combined with the project's pipeline practice of `git add -A` (per `feedback_stash_completely_before_pipelines.md`), a user who pastes an API key/token into a short issue body or title would commit it to git history through this log.

Three layered mitigations recommended; ship at least #1, prefer all three.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Add `artifacts/` (or specifically `artifacts/_dor/`) to repo `.gitignore`
- [ ] #2 Lower `BODY_INLINE_LIMIT` in calibration-log.ts so even short bodies switch to `bodySha` (e.g. drop from 500 chars to 80 chars; verify no test breakage from shorter inline)
- [ ] #3 Add a regex-based secret-redact pass over `title` + `bodyPreview` + LLM `finding`/`clarificationQuestion` strings before write; covers common patterns (`sk-...`, `ghp_...`, `AKIA...`, JWTs, generic `[A-Za-z0-9_-]{40,}` warnings)
- [ ] #4 Unit test asserting a known fake token (e.g. `sk-test-abcdef1234567890abcdef1234567890`) in the issue body is redacted in the persisted JSONL entry
- [ ] #5 Document the hardening in `pipeline-cli/docs/dor.md` under a 'Calibration log secret hygiene' section
<!-- AC:END -->
