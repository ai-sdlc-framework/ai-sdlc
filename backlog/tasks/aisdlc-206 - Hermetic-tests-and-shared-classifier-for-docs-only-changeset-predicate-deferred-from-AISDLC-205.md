---
id: AISDLC-206
title: >-
  Hermetic tests and shared classifier for docs-only changeset predicate
  (deferred from AISDLC-205)
status: To Do
assignee: []
created_date: '2026-05-05 22:30'
labels:
  - tech-debt
  - ci
  - testing
  - drift-prevention
dependencies:
  - AISDLC-205
references:
  - .github/workflows/verify-attestation-docs-only.yml
  - .github/workflows/ai-sdlc-review-docs-only.yml
  - .github/workflows/verify-attestation.yml
  - .github/workflows/ai-sdlc-review.yml
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

AISDLC-205 shipped the `verify-attestation-docs-only.yml` fallback workflow with a 3-iteration review loop that surfaced two MAJOR findings live (missing `merge_group` trigger, then non-ASCII filename `core.quotePath` asymmetry between the GH API enumeration path and the `git diff` enumeration path). The surviving deferred findings are all about preventing future regressions of the same class:

1. **Hermetic test for non-ASCII filename fixture.** The `core.quotePath=false` flag was added empirically — there's no test that constructs a fixture commit pair containing a non-ASCII filename and asserts the workflow's detect step returns `all_docs=true`. If someone strips the flag during a future cleanup, the regression is silent until a non-ASCII docs PR hits the queue.

2. **Shared docs-only path predicate.** The regex `^(spec/rfcs/|docs/|backlog/tasks/|backlog/completed/|[^/]+\.md$)` is now duplicated across 4 places that MUST stay in lock-step:
   - `.github/workflows/verify-attestation-docs-only.yml` (regex)
   - `.github/workflows/ai-sdlc-review-docs-only.yml` (regex)
   - `.github/workflows/verify-attestation.yml` (paths-ignore — different syntax, same semantics)
   - `.github/workflows/ai-sdlc-review.yml` (paths-ignore — different syntax, same semantics)

   If someone adds a new docs-prefix to either `paths-ignore` list (e.g., a `CHANGELOG.md` exception or `examples/**`) but forgets to update the regex copies, the deadlock returns. Pull the predicate into a single source of truth (e.g., `scripts/is-docs-only-changeset.mjs` + `.test.mjs`) consumed by both workflows AND asserted-equivalent to the paths-ignore lists.

3. **release-please skip guard nuance for merge_group head_ref.** AISDLC-205's release-please skip guard checks `github.event.merge_group.head_ref`, but on merge_group events that field is the queue branch name (e.g. `gh-readonly-queue/main/pr-N-<sha>`), NOT the original PR's source branch. So a release-please PR enqueued through the merge queue would NOT be skipped. Low practical impact (release-please typically auto-merges with admin and bypasses the queue), but worth fixing if the queue is ever enabled for release-please PRs. Resolve the underlying PR's source branch via `gh api` on merge_group runs, OR drop the guard and accept the consequence.

## Why this is a follow-up rather than blocking AISDLC-205

The MAJOR findings from iter-1 and iter-2 had concrete failure scenarios that would deadlock specific PR shapes (no-merge_group-trigger PRs, non-ASCII-filename PRs) — those needed to ship in AISDLC-205. The deferred items above are drift-prevention and edge-case polish: they don't deadlock anything in the common case, but they each represent a single point of failure for a future regression.

## Implementation notes

For #2 (shared classifier), suggested shape:

```js
// scripts/is-docs-only-changeset.mjs
export const DOCS_ONLY_PATTERN = /^(spec\/rfcs\/|docs\/|backlog\/tasks\/|backlog\/completed\/|[^/]+\.md$)/;
export function isDocsOnly(files) {
  return files.length > 0 && files.every(f => DOCS_ONLY_PATTERN.test(f));
}
```

Then both fallback workflows shell out:

```yaml
ALL_DOCS=$(node scripts/is-docs-only-changeset.mjs <<<"${FILES}")
```

And the paths-ignore equivalence test:

```js
// scripts/is-docs-only-changeset.test.mjs
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { DOCS_ONLY_PATTERN } from './is-docs-only-changeset.mjs';

for (const wf of ['verify-attestation.yml', 'ai-sdlc-review.yml']) {
  const parsed = yaml.load(readFileSync(`.github/workflows/${wf}`, 'utf8'));
  const pathsIgnore = parsed.on.pull_request['paths-ignore'];
  // Convert each glob to a regex and assert pattern equivalence on a representative path set
  // ... (or just assert byte-equality of the path list)
}
```

For #1 (non-ASCII fixture test), node:test pattern: create a temp git repo, commit a file with `é` in the name, run `git -c core.quotePath=false diff --name-only HEAD~ HEAD`, assert raw UTF-8 output. Then strip the `-c` flag and assert it produces C-quoted output (regression detector).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 New `scripts/is-docs-only-changeset.mjs` — exported `DOCS_ONLY_PATTERN` regex + `isDocsOnly(files)` helper, dependency-free
- [ ] #2 Both `.github/workflows/verify-attestation-docs-only.yml` and `.github/workflows/ai-sdlc-review-docs-only.yml` invoke the shared script (or its regex via `node -p`) instead of carrying inline regex copies
- [ ] #3 Hermetic test `scripts/is-docs-only-changeset.test.mjs` (node --test) covers: pure docs paths, pure code paths, mixed, empty, root *.md, root non-md, non-ASCII docs path, non-ASCII code path
- [ ] #4 Paths-ignore equivalence test asserts that the regex's positive matches mirror what `verify-attestation.yml`'s and `ai-sdlc-review.yml`'s `paths-ignore` would skip — fails loud if either workflow's list adds/removes an entry without the script being updated
- [ ] #5 Hermetic test for `core.quotePath=false` regression detector: constructs a fixture commit with a non-ASCII filename, asserts `git -c core.quotePath=false diff --name-only` returns raw UTF-8 (and assert WITHOUT the flag would return C-quoted, to detect future strip-the-flag regressions)
- [ ] #6 release-please skip guard correctness — either fix to resolve underlying PR head_ref via `gh api` on merge_group runs (so release-please PRs ARE correctly skipped on the queue), OR add a regression test asserting the guard ALWAYS evaluates true for known release-please queue branch shapes (acknowledging the gap explicitly)
- [ ] #7 New code reaches 80%+ patch coverage
<!-- AC:END -->
