---
id: AISDLC-36
title: Session-start .env preflight validation
status: Done
assignee: []
created_date: '2026-04-22 03:19'
updated_date: '2026-04-23 21:24'
labels:
  - plugin
  - hooks
  - dx
  - env
dependencies: []
references:
  - ai-sdlc-plugin/hooks/session-start.sh
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Separate from coverage — .env files with un-commented prose, spaces in keys, unbalanced quotes, or leading bullets cause godotenv parse errors that break every .env-using tool (supabase link, wrangler, etc.).

Fix: add a lightweight .env preflight check to session-start that scans .env files for common issues:
- Keys with spaces (MY KEY=value)
- Unbalanced quotes (KEY="value)
- Lines that look like prose/comments but aren't prefixed with #
- Leading bullets (- KEY=value)

Emit warnings (not blocking) so the user can fix before tools fail with cryptic parse errors.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Scans .env files for spaces in keys, unbalanced quotes, uncommented prose, leading bullets
- [x] #2 Emits warnings (advisory, not blocking)
- [x] #3 Does not modify .env files
<!-- AC:END -->
