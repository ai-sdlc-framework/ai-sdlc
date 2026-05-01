---
id: AISDLC-69.3
title: RFC drift detection CI script + workflow gate (enforces requiresDocs)
status: Done
assignee: []
created_date: '2026-04-30 16:40'
updated_date: '2026-05-01 01:50'
labels:
  - ci
  - rfc-process
  - follow-up
  - aisdlc-69
dependencies:
  - AISDLC-69.2
references:
  - scripts/check-docs-sync.mjs
  - scripts/verify-attestation.mjs
  - spec/rfcs/
  - docs/
  - .github/workflows/
  - package.json
parent_task_id: AISDLC-69
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Sub-task of AISDLC-69. Implements the CI gate that enforces the `requiresDocs` convention defined in AISDLC-69.2. **Hard dependency: AISDLC-69.2 must merge first.**

## What this task does

Implements:
1. A new Node script `scripts/check-rfc-docs.mjs` that:
   - Walks `spec/rfcs/RFC-*.md` (excluding `RFC-0001-template.md`)
   - Parses each RFC's YAML frontmatter
   - For RFCs with `status: Approved` or `status: Implemented`:
     - For each value in `requiresDocs`, verify at least one file under the corresponding `docs/` subdirectory contains a reference to the RFC's `id` (e.g., `RFC-0006`)
     - If `deferredDocs: true`, skip enforcement but log a warning
   - Exits 0 on clean, 1 on any failure (with a structured report listing each missing surface)
2. A `pnpm rfc:check` script in `package.json`
3. A test file `scripts/check-rfc-docs.test.mjs` with regression coverage
4. CI integration: add to `.github/workflows/ci.yml` (or extend the docs-check workflow from AISDLC-69.1)

## Implementation

### Script structure (mirror `scripts/check-docs-sync.mjs`)

```js
#!/usr/bin/env node
/**
 * Verifies that every Approved/Implemented RFC has corresponding user-facing docs.
 * Per AISDLC-69 convention: RFC frontmatter declares requiresDocs:[surfaces];
 * each surface must have at least one .md file under docs/<subdir>/ that
 * references the RFC's id (e.g., "RFC-0006").
 *
 * Used by .github/workflows/<...>.yml. Exits 0 on clean; 1 on any drift.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// Match the enum from AISDLC-69.2's RFC schema
const SURFACE_TO_DIR = {
  'tutorial': 'docs/tutorials',
  'operator-runbook': 'docs/operations',
  'api-reference': 'docs/api-reference',
  'getting-started': 'docs/getting-started',
  'example': 'docs/examples',
};

function parseFrontmatter(text) { /* ... */ }
function listRfcFiles(rfcsDir) { /* ... */ }
function findReferences(docsDir, rfcId) { /* recursively grep docs/<subdir>/*.md for rfcId */ }
function checkRfc(rfc) { /* return { rfc, missing: [...surfaces] } */ }

function main() {
  const rfcs = listRfcFiles('spec/rfcs').filter(f => basename(f) !== 'RFC-0001-template.md');
  const failures = [];
  for (const file of rfcs) {
    const fm = parseFrontmatter(readFileSync(file, 'utf-8'));
    if (!['Approved', 'Implemented'].includes(fm.status)) continue;
    if (fm.deferredDocs) {
      console.log(`[deferred] ${fm.id}: skipped (deferred until ${fm.deferredDocsDeadline ?? 'no deadline'})`);
      continue;
    }
    for (const surface of fm.requiresDocs ?? []) {
      const dir = SURFACE_TO_DIR[surface];
      if (!dir) {
        failures.push({ rfc: fm.id, reason: `unknown surface '${surface}'` });
        continue;
      }
      if (!findReferences(dir, fm.id)) {
        failures.push({ rfc: fm.id, reason: `surface '${surface}' has no doc referencing ${fm.id} under ${dir}/` });
      }
    }
  }
  if (failures.length) {
    console.error(`[rfc-check] FAIL: ${failures.length} drift(s)`);
    for (const f of failures) console.error(`  - ${f.rfc}: ${f.reason}`);
    process.exit(1);
  }
  console.log(`[rfc-check] OK: ${rfcs.length} RFCs verified`);
}

main();
```

### Reference dependency
Use the SAME yaml parsing approach as the rest of the codebase. If gray-matter is already a dep, use it; otherwise use the lightweight inline parser pattern from `scripts/verify-attestation.mjs`'s `parseTrustedReviewers`.

### CI integration
Pick ONE:
- **A)** Add `pnpm rfc:check` as a step in `.github/workflows/ci.yml` (probably in the `Build & Test` job, post-install)
- **B)** Add to the docs-check workflow from AISDLC-69.1 (single dedicated workflow for docs-related checks)

Option B is cleaner if AISDLC-69.1 went with its Option B (dedicated workflow). Match the choice.

### User feedback (educational comments)
For now, just emit clear stderr messages. Do NOT post PR comments — that adds GitHub API surface. If reviewers ask for it, file a follow-up task.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. New script `scripts/check-rfc-docs.mjs` implementing the algorithm above
2. New test file `scripts/check-rfc-docs.test.mjs` covering: (a) clean state passes, (b) missing surface fails with named RFC + surface, (c) `deferredDocs: true` short-circuits with warning, (d) `status: Draft` is skipped, (e) `requiresDocs: []` passes vacuously, (f) malformed frontmatter rejected with clear error
3. `package.json` adds `"rfc:check": "node scripts/check-rfc-docs.mjs"` script
4. `pnpm test` includes `pnpm rfc:check` in its chain (probably append to existing `"test"` script)
5. `.github/workflows/...` runs `pnpm rfc:check` on every PR + merge_group event
6. Failure of `rfc:check` blocks the PR (required check; coordinate with branch protection per AISDLC-69.1)
7. CHANGELOG entry under `ai-sdlc-plugin/CHANGELOG.md`
8. New code: 80%+ patch coverage. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
9. Verify against current main: with the convention from AISDLC-69.2 in place, `pnpm rfc:check` passes (modulo gaps captured by AISDLC-69.4 + per-RFC follow-ups)

## Out of scope

- Defining the `requiresDocs` convention (AISDLC-69.2)
- Authoring missing docs (AISDLC-69.4 + per-RFC follow-ups)
- Posting educational PR comments on first failure (future enhancement if needed)
- Rewriting `check-docs-sync.mjs` (that's a separate concern — docs↔published drift, not RFC↔docs binding)

## References

- AISDLC-69.2 (the convention this script enforces — hard prerequisite)
- AISDLC-69.1 (the docs-check workflow — possible insertion point)
- `scripts/check-docs-sync.mjs` (structural reference: walk files, validate, exit 0/1)
- `scripts/verify-attestation.mjs` (pattern reference: parse YAML frontmatter, structured failure reporting)
- `package.json` (script registration)
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 New script scripts/check-rfc-docs.mjs implementing the algorithm above
- [x] #2 New test file scripts/check-rfc-docs.test.mjs covering: (a) clean state passes, (b) missing surface fails with named RFC + surface, (c) deferredDocs: true short-circuits with warning, (d) status: Draft is skipped, (e) requiresDocs: [] passes vacuously, (f) malformed frontmatter rejected with clear error
- [x] #3 package.json adds 'rfc:check': 'node scripts/check-rfc-docs.mjs' script
- [x] #4 pnpm test includes pnpm rfc:check in its chain (probably append to existing 'test' script)
- [ ] #5 .github/workflows/... runs pnpm rfc:check on every PR + merge_group event
- [ ] #6 Failure of rfc:check blocks the PR (required check; coordinate with branch protection per AISDLC-69.1)
- [x] #7 CHANGELOG entry under ai-sdlc-plugin/CHANGELOG.md
- [x] #8 New code: 80%+ patch coverage. pnpm build && pnpm test && pnpm lint && pnpm format:check clean
- [x] #9 Verify against current main: with the convention from AISDLC-69.2 in place, pnpm rfc:check passes (modulo gaps captured by AISDLC-69.4 + per-RFC follow-ups)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Shipped `scripts/check-rfc-docs.mjs` enforcing the AISDLC-69.2 `requiresDocs` convention. Walks `spec/rfcs/RFC-*.md`, parses YAML frontmatter, validates each declared surface has at least one `.md` under the corresponding `docs/<subdir>/` referencing the RFC by ID. `deferredDocs:true` short-circuits with deadline-aware warning. Wired `pnpm rfc:check` + `pnpm rfc:test` into the root pnpm test chain.

## Changes
- `scripts/check-rfc-docs.mjs` (NEW)
- `scripts/check-rfc-docs.test.mjs` (NEW, 46 tests)
- `package.json` (added rfc:check + rfc:test scripts)
- `ai-sdlc-plugin/CHANGELOG.md`

## Verification
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — clean (modulo pre-existing dogfood/runner flake)
- 46/46 rfc-docs tests pass
- RFC enforcement on current main: PASSES (8 RFCs walked, 2 enforced, 6 skipped Draft, 1 deferred RFC-0006)
- 3 parallel reviews APPROVED (0 critical, 0 major, 3 minor, 3 suggestions); ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable)

## AC status
- ✓ #1, #2, #3, #4, #7, #8, #9 — fully met
- ✗ #5 + #6 (`.github/workflows/` wiring + required-check) — INTENTIONALLY blocked path; operator follow-up to add `pnpm rfc:check` step to ci.yml

## Follow-up (non-blocking)
- **Code minor**: `--rfcs-dir`/`--docs-dir` no-value crashes ungracefully; one-line guard would polish
- **Code suggestion**: substring reference matching (`text.includes(rfcId)`) admits future false positives once IDs cross RFC-1000; word-boundary regex would future-proof
- **Code suggestion**: `deferredDocs:true` on Draft RFC silently swallowed; could detect as frontmatter smell
- **Test minor**: substring-match behavior not directly tested
- **Test minor**: `Final + missing-docs → failure` integration assertion would be cleaner
<!-- SECTION:FINAL_SUMMARY:END -->
