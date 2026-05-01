---
id: AISDLC-115.2
title: 'Phase 2a: Deterministic Stage A + test corpus'
status: Done
assignee: []
created_date: '2026-05-01 16:25'
labels:
  - rfc-0011
  - phase-2a
  - deterministic
  - corpus
milestone: m-3
dependencies:
  - AISDLC-115.1
references:
  - >-
    spec/rfcs/RFC-0011-definition-of-ready-gate.md#44-deterministic-first-evaluation-order
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#56-corpus
  - spec/dor-corpus/
parent_task_id: AISDLC-115
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deterministic Stage A: regex / structural / link-check evaluators that catch ~40-60% of unready issues at zero LLM cost (per RFC §4.4 + Q10 cost analysis). Ships with the test corpus that becomes the ongoing regression gate. Per RFC §12 Phase 2a.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Stage A modules implemented per RFC §4.4: regex/link-check/structural validation for each of the 7 gates that have a deterministic component
- [ ] #2 Test corpus seeded at `spec/dor-corpus/`: 30 ready + 35 needs-clarification + 10 edge-case fixtures (matches RFC §5.6 spec)
- [ ] #3 Resolver registry (`resolveReference`) ships with 3 resolvers: github-issue, file-existence, URL HEAD (per Q2 resolution)
- [ ] #4 CI gate enforces 100% Stage A correctness against the corpus (any drift fails CI)
- [ ] #5 Stage A runs in <100ms per issue (perf budget per RFC §12 Phase 2a)
- [ ] #6 Stage A ships standalone — issues passing Stage A are admitted as `ready` until Phase 2b lands the LLM Stage B
- [ ] #7 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
RFC-0011 Phase 2a: 7-gate deterministic Stage A evaluator + 76-fixture test corpus + 3-resolver registry + 2 CLI subcommands (dor-evaluate, dor-corpus). Stage A runs <1ms per fixture (well under 100ms budget). Gates 4 (scope) + 6 (done-state) pure Stage B per RFC §4.4 — return verdict:'skip' with soft heuristic findings; corpus fixtures document Stage B expectation.

## Verification
- pipeline-cli 404/404 tests pass; coverage 87.56%/100%/75% on dor module (above 80% target)
- pnpm build && pnpm test && pnpm lint && pnpm format:check clean
- 3 reviews APPROVED: code 0c/0M/4m/0s; test 0c/0M/2m/0s; security 0c/0M/2m/0s

## Follow-ups (filed)
- AISDLC-121: SSRF — url-head resolver should block private IPs
- AISDLC-122: Path traversal — file-existence resolver should reject `..` segments

## Other reviewer minors (defer to Phase 2b or follow-up)
- --quiet option declared but unused in dor-corpus handler
- Hermetic mode honors user-supplied resolvers (could break contract)
- Single AbortController shared across HEAD+GET fallback in url-head
- url-head test gated by `!globalThis.fetch` is dead code on Node 18+
- No CLI integration test for dor-corpus subcommand
<!-- SECTION:FINAL_SUMMARY:END -->
