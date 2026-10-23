---
id: AISDLC-782
title: >-
  fixed-prefix tiering, path-bound rules and control linter
status: In Progress
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-3
dependencies:
  - AISDLC-773
  - AISDLC-742
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - CLAUDE.md
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - backlog/completed/aisdlc-742 - condense claude.md to rules and pointers to cut the per-call context floor (63 kb to at most 20 kb).md
  - backlog/completed/aisdlc-651.2 - fixed prefix diet for claude md and injected governance.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the RFC-0053 OQ-4 resolution as a structural rule. The fixed prefix is governance controls rendered from `spec.governance` configuration (RFC-0048), the role and task frame, and pointers, under `prefix.maxBytes` (10240). Path-bound CLAUDE.md sections move to `.claude/rules/*.md` with `paths:` frontmatter, which the harness loads deterministically. Explanatory, historical and rationale sections are ingested as knowledge entries. A linter refuses a control-shaped sentence (never, must, refuse, only) outside the prefix unless it is also rendered from configuration. Supersedes the one-time diet in AISDLC-742 and absorbs the fixed-prefix work in AISDLC-651.2; AISDLC-742 is listed in `dependencies:` so whichever lands first stays consistent.

Sequencing: listed in `dependencies:` (AISDLC-773, AISDLC-742).
<!-- SECTION:DESCRIPTION:END -->

**Five-step review (requirements first).** (1) Requirement questioned: "every control sentence lives in the always-loaded CLAUDE.md" (set by the pre-RFC-0053 prompt layout); only controls rendered from configuration need the fixed prefix. (2) Delete: control prose duplicated outside the prefix, and the one-time diet in AISDLC-742 that this supersedes. (3) Simplify: path-bound sections move to `.claude/rules/*.md` loaded by the harness instead of a custom loader. (4) Accelerate: the prefix size cap is a test, so growth fails fast rather than in review. (5) Automate: the control-sentence linter, last.

## Acceptance Criteria

- [x] The rendered fixed prefix is at most `prefix.maxBytes` bytes and a test fails when it grows past it.
- [x] The prefix contains governance controls rendered from configuration, the role and task frame, and pointers, and nothing else (test on the renderer).
- [x] Each path-bound section moved to `.claude/rules/*.md` carries `paths:` frontmatter and loads when a matching file is opened (fixture test).
- [x] The linter fails on a control-shaped sentence outside the prefix that is not rendered from configuration and passes when it is (test per case).
- [x] Explanatory sections are ingested as knowledge entries with trunk, source and decay (test).
- [x] No control present in the prior CLAUDE.md is lost: a test maps each control sentence to the prefix or to a rule file.
- [x] The task states it supersedes the AISDLC-742 one-time diet, and the AISDLC-742 task file points here.
