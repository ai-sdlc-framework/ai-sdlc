---
id: LT-718
title: >-
  Add CSRF/Origin protection to the outreach worker's state-changing endpoints
  (esp. /api/profile)
status: To Do
assignee: []
created_date: '2026-10-03 21:37'
labels:
  - security
  - outreach-board
dependencies: []
references:
  - prospects/outreach-app/src/index.js
  - prospects/outreach-app/src/routes/telephony.js
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Flagged during LT-716 security review (2026-10-03). The outreach app worker (prospects/outreach-app) has NO CSRF/Origin check on its state-changing endpoints -- a pre-existing gap across the whole worker. Impact rose with LT-716: PUT /api/profile now sets (1) the booking link embedded in prospect-facing campaign emails and (2) the personal phone that the Twilio bridge dials, so a CSRF against an authenticated operator could redirect prospect CTAs or set a dialed number. Auth is HTTP Basic, which browsers attach automatically, so CSRF is viable.

Add Origin/Referer validation (or a CSRF token) to state-changing endpoints (PUT/POST/DELETE), starting with /api/profile, /api/telephony/config, /api/calls/dial, /api/campaign/send-email. Reject cross-origin state-changing requests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 State-changing endpoints (PUT/POST/DELETE) on the outreach worker reject requests whose Origin/Referer is not the board's own origin (or require a CSRF token)
- [ ] #2 /api/profile, /api/telephony/config, /api/calls/dial, /api/campaign/send-email are covered
- [ ] #3 Legitimate same-origin board requests still work; a cross-origin forged request is rejected. Mutation-tested
<!-- AC:END -->
