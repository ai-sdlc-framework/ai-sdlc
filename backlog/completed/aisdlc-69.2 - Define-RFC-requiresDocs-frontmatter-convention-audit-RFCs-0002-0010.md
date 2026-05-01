---
id: AISDLC-69.2
title: Define RFC requiresDocs frontmatter convention + audit RFCs 0002–0010
status: Done
assignee: []
created_date: '2026-04-30 16:40'
updated_date: '2026-05-01 00:47'
labels:
  - docs
  - rfc-process
  - follow-up
  - aisdlc-69
dependencies: []
references:
  - spec/rfcs/RFC-0001-template.md
  - spec/rfcs/README.md
  - spec/rfcs/RFC-0002-pipeline-orchestration-policy.md
  - spec/rfcs/RFC-0003a-infrastructure-provider-adapters.md
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
  - docs/
  - ai-sdlc-io/content/docs/
parent_task_id: AISDLC-69
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Sub-task of AISDLC-69. Establishes the schema/convention that AISDLC-69.3 (the CI gate) will enforce. **Must land before AISDLC-69.3.**

Per the explore-agent's research:
- 9 RFCs exist (`spec/rfcs/RFC-NNNN-*.md`), all listed as `Draft` in `spec/rfcs/README.md` despite some being marked `Final` internally (RFC-0006, RFC-0008)
- RFC-0001 is the template; current frontmatter is markdown-bold style (`**Status:** Draft`) not YAML
- No RFC declares which user-facing docs it requires
- `docs/` has subdirs: `api-reference/`, `getting-started/`, `tutorials/`, `operations/`, `examples/`
- 218 RFC references exist across `ai-sdlc-io/content/` (published tree), 10+ in `docs/`

## What this task does

1. Define a YAML frontmatter convention for RFCs that declares which doc surfaces they require
2. Update `RFC-0001-template.md` to include the new field with explanation
3. Audit RFCs 0002–0010 — for each, decide what doc surfaces it requires + populate the frontmatter
4. Update `spec/rfcs/README.md` with the new convention + operator process

## Convention design

Use a fenced YAML frontmatter block at the TOP of each RFC (Markdown-style `---` delimiter). This is parseable by gray-matter or any standard YAML parser.

Example:
```markdown
---
id: RFC-0006
title: Design System Governance
status: Approved
author: Dom Legault
created: 2026-04-05
updated: 2026-04-13
requiresDocs:
  - tutorial          # docs/tutorials/<feature>.md
  - operator-runbook  # docs/operations/<feature>.md
  - api-reference     # docs/api-reference/<feature>.md
deferredDocs: false   # if true, requires `deferredDocsDeadline: YYYY-MM-DD`
---

# RFC-0006: Design System Governance
[...rest of RFC body...]
```

### Allowed `requiresDocs` enum values
Pick a closed set that maps to existing `docs/` subdirectories:
- `tutorial` → `docs/tutorials/`
- `operator-runbook` → `docs/operations/`
- `api-reference` → `docs/api-reference/`
- `getting-started` → `docs/getting-started/`
- `example` → `docs/examples/`

Each value, when present in `requiresDocs`, means "at least one file in the corresponding subdirectory must reference RFC-NNNN by number." (The CI script in AISDLC-69.3 will enforce this.)

### Status field normalization
The current `**Status:** Draft` markdown-bold is inconsistent with structured frontmatter. Migrate ALL existing RFCs to `status: Draft|Approved|Implemented|Rejected|Withdrawn` in YAML frontmatter. Keep the visible bold-status text in the body too (for human readability) but the frontmatter is the source of truth for tooling.

### Deferred docs escape hatch
Some RFCs are conceptual/strategic and don't have user-facing docs (yet). For those:
- `requiresDocs: []` (empty array) → CI passes
- OR `deferredDocs: true` + `deferredDocsDeadline: YYYY-MM-DD` → CI passes BUT logs a warning + reminder when deadline approaches (warning only — actual deadline enforcement deferred to a future task)

## Audit scope

For each RFC 0002–0010:
1. Read the RFC to understand scope
2. Decide which doc surfaces it requires (probably 1-3 of the enum values above)
3. Add the `requiresDocs:` field to the RFC's frontmatter
4. If the required docs DO NOT yet exist, create a follow-up Backlog.md task (AISDLC-N) for each gap (e.g., "Author tutorial for RFC-0007"). For RFC-0006 specifically, AISDLC-69.4 is already that follow-up.
5. Update `spec/rfcs/README.md`'s RFC index table to reflect actual statuses (RFC-0006 is Final not Draft)

## Acceptance Criteria
<!-- AC:BEGIN -->
1. RFC-0001-template.md updated with YAML frontmatter including `id`, `title`, `status`, `author`, `created`, `updated`, `requiresDocs`, optional `deferredDocs` + `deferredDocsDeadline` fields. Each field documented with comments.
2. `spec/rfcs/README.md` updated with: (a) the new convention explained, (b) operator process: "when authoring an RFC, declare requiresDocs and ensure each surface has at least one doc referencing the RFC number before requesting Approved status", (c) refreshed RFC index table reflecting actual statuses.
3. JSON schema OR documented enum: the closed set of valid `requiresDocs` values is captured (either in a schema file under `spec/schemas/rfc.schema.json` or inline in the README) so AISDLC-69.3's CI script can use it.
4. RFCs 0002–0010 each receive YAML frontmatter (migration from markdown-bold style). Status values normalized to enum.
5. Each RFC's `requiresDocs` populated with the audited set. If empty (`[]`), document why in the RFC body.
6. For each gap discovered (RFC requires a surface that doesn't exist yet), create a follow-up backlog task. RFC-0006's gaps are already AISDLC-69.4; only file new tasks for OTHER RFCs' gaps.
7. CHANGELOG entry under `ai-sdlc-plugin/CHANGELOG.md`
8. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
9. SKIP CI script implementation — that's AISDLC-69.3

## Out of scope

- The CI script that enforces the convention (separate task AISDLC-69.3)
- Authoring the missing docs themselves (AISDLC-69.4 for RFC-0006; per-RFC follow-up tasks for others)
- Wiring deferredDocsDeadline reminders (future task)
- Migrating to a different RFC numbering scheme

## References

- `spec/rfcs/RFC-0001-template.md` (current template — needs major rewrite)
- `spec/rfcs/README.md` (RFC process docs — needs update)
- All `spec/rfcs/RFC-*.md` files (need frontmatter migration)
- `docs/` subdirectories (the surfaces being declared)
- `backlog/completed/aisdlc-68 -*.md` (docs consolidation context)
- AISDLC-69.3 (the CI script that consumes this convention — must land AFTER this)
- AISDLC-69.4 (RFC-0006 retroactive docs — depends on this audit identifying the gaps)
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 RFC-0001-template.md updated with YAML frontmatter including id, title, status, author, created, updated, requiresDocs, optional deferredDocs + deferredDocsDeadline fields. Each field documented with comments.
- [x] #2 spec/rfcs/README.md updated with: (a) the new convention explained, (b) operator process: 'when authoring an RFC, declare requiresDocs and ensure each surface has at least one doc referencing the RFC number before requesting Approved status', (c) refreshed RFC index table reflecting actual statuses.
- [x] #3 JSON schema OR documented enum: the closed set of valid requiresDocs values is captured (either in a schema file under spec/schemas/rfc.schema.json or inline in the README) so AISDLC-69.3's CI script can use it.
- [x] #4 RFCs 0002–0010 each receive YAML frontmatter (migration from markdown-bold style). Status values normalized to enum.
- [x] #5 Each RFC's requiresDocs populated with the audited set. If empty ([]), document why in the RFC body.
- [x] #6 For each gap discovered (RFC requires a surface that doesn't exist yet), create a follow-up backlog task. RFC-0006's gaps are already AISDLC-69.4; only file new tasks for OTHER RFCs' gaps.
- [x] #7 CHANGELOG entry under ai-sdlc-plugin/CHANGELOG.md
- [x] #8 pnpm build && pnpm test && pnpm lint && pnpm format:check clean
- [x] #9 SKIP CI script implementation — that's AISDLC-69.3
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Defines the RFC `requiresDocs` YAML frontmatter convention end-to-end. Ships JSON schema (`spec/schemas/rfc.schema.json`) with closed enum, rewrites RFC-0001 template, refreshes README index (RFC-0006/0008 now correctly Final), migrates all 8 real RFCs to YAML frontmatter, populates each `requiresDocs:` per audit, and files 5 follow-up backlog tasks for doc-reference gaps surfaced.

## Changes

- `spec/schemas/rfc.schema.json` — NEW (closed enum: tutorial / operator-runbook / api-reference / getting-started / example; conditional deferredDocsDeadline)
- `spec/rfcs/RFC-0001-template.md` — rewritten with YAML frontmatter
- `spec/rfcs/README.md` — operator process + refreshed index
- 8 RFC files (0002, 0003a, 0003b, 0004, 0005, 0006, 0008, 0010) migrated from markdown-bold-status to YAML frontmatter
- 5 NEW follow-up backlog tasks: AISDLC-69.5 (RFC-0002 doc refs), 69.6 (RFC-0003 adapters), 69.7 (RFC-0004 cost-governance docs), 69.8 (RFC-0005 PPA refs), 69.9 (RFC-0010 worktree-pool API ref)
- `reference/src/core/generated-schemas.ts` — regenerated (build artifact)
- `ai-sdlc-plugin/CHANGELOG.md` — entry

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — clean
- `node --test 'ai-sdlc-plugin/**/*.test.mjs'` — 175/175 pass
- All 8 migrated RFCs validate against the new JSON schema
- All 9 RFCs parse cleanly with js-yaml
- 3 parallel reviews APPROVED (0 critical, 0 major, 5 minor, 1 suggestion); ⚠ INDEPENDENCE NOT ENFORCED

## Follow-up (non-blocking minors from reviews)

- **Code reviewer**: phantom AISDLC-69.4 reference in RFC-0006 + CHANGELOG. Note: AISDLC-69.4 EXISTS on main (filed earlier this session) but the worktree was branched before that — reviewer's "doesn't exist" finding is a worktree-staleness artifact. Verify post-merge.
- **Code/Test reviewers**: RFC-0001 template's placeholder values (`RFC-NNNN`, `YYYY-MM-DD`) fail strict schema validation. AISDLC-69.3 (the CI gate) needs to skip the template explicitly. Adding a note to AISDLC-69.3's task description as part of follow-up.
- **Code reviewer suggestion**: cross-loader date portability — unquoted `YYYY-MM-DD` parses as `datetime.date` in Python's pyyaml but as string in Node's yaml. AISDLC-69.3 will be Node-based, so OK; consider quoting dates in frontmatter if cross-language ever matters.
- **Test reviewer**: pre-existing dogfood/runner/exports flaky test (5s timeout under parallel load, passes in isolation). Pre-existing, not introduced by this PR.
- **Test reviewer suggestion**: add a co-located schema-validation test in `reference/`. AISDLC-69.3 will exercise this end-to-end; non-blocking.

This unblocks AISDLC-69.3 (RFC drift CI script) which is the next step.
<!-- SECTION:FINAL_SUMMARY:END -->
