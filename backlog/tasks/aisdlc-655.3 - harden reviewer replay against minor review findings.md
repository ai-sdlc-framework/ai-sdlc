---
id: AISDLC-655.3
title: >-
  RFC-0050: harden reviewer replay against minor review findings
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - model-routing
  - evaluation
dependencies:
  - AISDLC-655
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/usage/replay-run.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Defense-in-depth items from the reviews of the replay change. (1) Config-name folding does not strip the code points that HFS+ ignores when comparing names (U+200C to U+200F, U+202A to U+202E, U+206A to U+206F, U+FEFF); strip them before normalising. (2) Claude Code also reads CLAUDE.md from ancestor directories, and on a shared Linux temp directory another user could plant one; default the clone root to a per-user directory and verify that the CLAUDE.md-disabling variable is honoured by the installed CLI. (3) A transient API error ends the whole run; allow one retry before treating a spawn as a usage gap. (4) Add a test that sends a real SIGTERM to a running replay and asserts that the child is killed and the clone removed. (5) Consider an operating-system level sandbox around the reviewer process.

Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] A committed file whose name differs from CLAUDE.md only by HFS+-ignorable code points is removed from the clone, in a test.
- [ ] The clone root is a per-user directory on Linux.
- [ ] One transient spawn error is retried once and a second failure stops the run, in a test.
- [ ] A real SIGTERM test kills the child and removes the clone.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
