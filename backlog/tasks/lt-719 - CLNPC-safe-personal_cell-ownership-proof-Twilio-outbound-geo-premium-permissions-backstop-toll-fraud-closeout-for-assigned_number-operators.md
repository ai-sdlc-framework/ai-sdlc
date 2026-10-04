---
id: LT-719
title: >-
  CLNPC-safe personal_cell ownership proof + Twilio outbound geo/premium
  permissions backstop (toll-fraud closeout for assigned_number operators)
status: To Do
assignee: []
created_date: '2026-10-03 21:38'
labels:
  - security
  - telephony
  - outreach-board
dependencies:
  - LT-716
references:
  - prospects/outreach-app/src/routes/telephony.js
  - prospects/outreach-app/migrations/
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from LT-716 (2026-10-03). LT-716 applied (b) reset-verification-on-change and (d) +1-only, but a bounded toll-fraud surface remains for operators WITH an assigned_number: handleCallsDial (telephony.js ~700) uses callerId=assigned_number and never consults verified_caller_id, so it rings whatever personal_cell is stored, verified or not. This is DELIBERATE LT-580 behaviour (lets a CLNPC-blocked operator, e.g. Jason/MN, dial despite being unable to complete Twilio caller-ID verification). The (d) +1-only guard closes non-NANP international premium, but NOT +1-900 premium or high-cost +1 Caribbean NANP (876, 809, etc.), which are still +1.

Two mitigations:
1. CODE: add a CLNPC-independent ownership proof for personal_cell -- e.g. place an automated call or SMS to the entered number with a code the operator reads/enters back -- recorded as personal_cell_verified_at. Then gate /api/calls/dial on a proven personal_cell REGARDLESS of assigned_number, so LT-580 operators get a path to prove ownership that works despite CLNPC.
2. OPERATOR/ACCOUNT (the real backstop, document as a runbook step): configure Twilio account-level outbound Voice Geographic Permissions to block high-cost destinations (+1-900 premium, high-cost Caribbean NANP) and allow only US/CA. This closes premium toll fraud at the account even for an unverified number.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A personal_cell ownership proof exists that works WITHOUT Twilio caller-ID verification (CLNPC-safe), recording personal_cell_verified_at
- [ ] #2 /api/calls/dial requires a proven personal_cell (caller-ID verification OR the new proof) regardless of assigned_number; an unproven personal_cell returns 409
- [ ] #3 A CLNPC-blocked operator (assigned_number, cannot complete Twilio caller-ID verify) can complete the new proof and then dial
- [ ] #4 Runbook documents the Twilio account-level outbound geographic/premium permissions to set (block +1-900 and high-cost Caribbean NANP, allow US/CA). Mutation-tested
<!-- AC:END -->
