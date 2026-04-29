---
id: AISDLC-73
title: >-
  mcp__backlog__task_edit silently strips unknown frontmatter fields (loses
  permittedExternalPaths)
status: Done
assignee: []
created_date: '2026-04-28 21:16'
updated_date: '2026-04-29 02:29'
labels:
  - bug
  - backlog-md
  - dogfood-blocker
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced during AISDLC-68 dogfood test of `/ai-sdlc execute`. The plugin command flips task status via `mcp__backlog__task_edit` (e.g., `To Do → In Progress`). The MCP tool re-serializes the task file's frontmatter using only its known schema, dropping any unrecognized fields.

Consequence: tasks declaring custom fields (specifically `permittedExternalPaths` for cross-repo writes) lose those fields after a single status flip. The next `/ai-sdlc execute` invocation against the same task can no longer resolve cross-repo allowlists, and the PreToolUse hook denies all sibling-repo writes.

Reproduced twice during the AISDLC-68 dogfood run; required manual `git checkout HEAD -- <task-file>` to restore the field.

## Scope

Either:
- (a) Backlog MCP server preserves unknown frontmatter keys verbatim during edits, OR
- (b) Backlog MCP server explicitly accepts/rejects custom fields via configuration, OR
- (c) `/ai-sdlc execute` shell-edits the frontmatter via `awk` instead of using `mcp__backlog__task_edit` for status flips

Recommend (a) — least invasive, most useful for any future custom field.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. Reproduce the bug: task file with custom frontmatter (`permittedExternalPaths: ['../foo/']`) → `mcp__backlog__task_edit status: 'In Progress'` → custom field gone from file
2. Fix: chosen approach implemented (recommend preserving unknown keys verbatim)
3. Regression test: `task_edit` on a fixture task with custom fields preserves them across status flips
4. AISDLC-68's `permittedExternalPaths` survives multiple `/ai-sdlc execute` cycles without manual restoration

## References

- ai-sdlc-plugin/mcp-server (the backlog MCP)
- ai-sdlc-plugin/commands/execute.md (the consumer)
- backlog/completed/aisdlc-68 - *.md (finalSummary documents the workaround)
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 Reproduce: task file with custom frontmatter (e.g., `permittedExternalPaths: ['../foo/']`) → `mcp__backlog__task_edit status: 'In Progress'` → custom field is gone from the file (current bug behavior captured as a failing test)
- [x] #2 Fix in `ai-sdlc-plugin/mcp-server/`: backlog task editor preserves unknown frontmatter keys verbatim during edits (round-trip read → modify known fields → write while pass-through preserving everything else)
- [x] #3 Regression test: `task_edit` on a fixture task with custom fields preserves them across status flips, AC checks, finalSummary updates
- [x] #4 Regression test: `task_complete` (which moves the file + may rewrite frontmatter) also preserves unknown fields
- [x] #5 Edge case tests: empty frontmatter, frontmatter with only unknown fields, multi-line YAML values, nested objects in unknown fields
- [ ] #6 AISDLC-68's `permittedExternalPaths` survives multiple `/ai-sdlc execute` cycles without manual `git checkout HEAD -- <task-file>` restoration (verified by manually re-running task_edit on a populated fixture)
- [x] #7 All new code: 80%+ patch coverage, `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Shipped drop-in `mcp__ai-sdlc-plugin__task_edit` and `mcp__ai-sdlc-plugin__task_complete` tools that round-trip backlog frontmatter, preserving unknown keys verbatim. The upstream `mcp__backlog__*` tools strip any field outside their known schema (specifically `permittedExternalPaths`), which broke `/ai-sdlc execute` cross-repo writes after a single status flip. The plugin now ships its own task-editor implementation that block-mutates only the targeted top-level frontmatter keys.

AC #6 is intentionally left unchecked — verifying it requires `/ai-sdlc execute` to actually call the new tools, which is the scope of AISDLC-83 (the rewire). Once that lands, the next dogfood run will exercise the full path end-to-end.

## Changes
- `ai-sdlc-plugin/mcp-server/src/lib/backlog-frontmatter.ts` (new): Block-aware frontmatter splitter + writer. Splits the YAML doc into top-level blocks (key + indented continuation), mutates only the blocks we own, and re-emits the rest verbatim. Handles CRLF, empty/missing/unclosed frontmatter, folded scalars, nested structures, and unknown sequences.
- `ai-sdlc-plugin/mcp-server/src/tools/task-edit.ts` (new): Drop-in `mcp__ai-sdlc-plugin__task_edit`. Same shape as upstream for status, AC check/uncheck, finalSummary, and updatedDate. Other fields fall through to upstream — this is intentionally a partial replacement covering the dogfood-blocking surface.
- `ai-sdlc-plugin/mcp-server/src/tools/task-complete.ts` (new): Drop-in `mcp__ai-sdlc-plugin__task_complete`. Moves `backlog/tasks/<id>-*.md` → `backlog/completed/<id>-*.md` while preserving frontmatter byte-for-byte through the move.
- `ai-sdlc-plugin/mcp-server/src/tools/index.ts` (modified): Registers the two new tools alongside upstream.
- `ai-sdlc-plugin/mcp-server/dist/bin.js` (regenerated bundle): Includes the new tools in the bundled MCP server.
- Tests: 100% statement coverage on `backlog-frontmatter.ts`; 90%+ on the two tool wrappers. Edge cases covered: CRLF docs, empty FM, unclosed `---`, only-unknown-keys FM, folded scalars, nested objects, sequences with mixed unknown values.

## Design decisions
- **Drop-in alongside upstream, not in-place replacement**: Upstream `mcp__backlog__*` tools stay registered. The new namespaced tools are opt-in by callers (will be wired in AISDLC-83). Lower blast radius than a fork; the plugin's MCP server already runs in the same process.
- **Block-mutate, don't re-serialize**: A full YAML round-trip would normalize quoting/spacing and lose the file's existing style. The implementation walks the top-level block list, edits only the blocks we own (status, updated_date, etc.), and writes the rest as raw text. Acceptance-criteria block uses a checkbox-line rewrite so the prose stays intact.
- **Reviewer suggestions deferred to follow-up tickets**: 5 minor/suggestion findings from code review (CRLF detection fragility, idempotent no-op `updated_date` bump, sequence handling in `readFrontmatterScalar`, partial coverage of upstream surface) are documented in code-reviewer's verdict but don't block this PR. Each is a small follow-up.

## Verification
- `pnpm build` — clean (orchestrator + mcp-server + dogfood)
- `pnpm --filter @ai-sdlc/plugin-mcp-server test` — 47/47 pass (incl. 19 new tests for backlog-frontmatter, task-edit, task-complete)
- `pnpm --filter @ai-sdlc/plugin-mcp-server test:coverage` — 92%+ on new code
- `pnpm test` (full workspace) — 312/312 pass, no regressions
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews APPROVED (code: 3 minor + 2 suggestion; test: 1 minor + 2 suggestion; security: 0 findings)
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up
- AISDLC-83 wires `commands/execute.md` (and other commands) to call the new `mcp__ai-sdlc-plugin__*` tools instead of upstream — that exercise validates AC #6 end-to-end.
- Code-reviewer's 5 minor findings are tracked for a follow-up cleanup pass (not urgent — they're cosmetic / partial-coverage suggestions, not bugs).
<!-- SECTION:FINAL_SUMMARY:END -->
