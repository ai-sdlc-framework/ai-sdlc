---
paths:
  - "spec/rfcs/**"
---

# RFCs

`spec/rfcs/RFC-NNNN-*.md` ([process](spec/rfcs/README.md)). Lifecycle: `Draft` → `Ready for Review` → `Signed Off` → `Implemented` (or `Superseded`). Next number: the README Registry's "Next available number" line, never a file scan. `requires:` = runtime-code dependency (must be `Implemented`); `assumes:` = design-contract dependency (must exist); the DoR upstream-OQ gate blocks on `requires:` only. Semantics: [`docs/operations/backlog-and-execution-reference.md`](docs/operations/backlog-and-execution-reference.md).
