---
id: AISDLC-1390
title: 'The readiness check treats a bot-blocked URL as unverified, and checks frontmatter URLs as URLs'
status: To Do
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - pipeline-cli
  - dor
dependencies: []
references:
  - pipeline-cli/src/dor/resolvers/url-head.ts
  - pipeline-cli/src/dor/gates/gate-3-references.ts
  - pipeline-cli/src/dor/resolvers/index.ts
priority: low
---

## Description

**Gap.** `pipeline-cli/src/dor/resolvers/url-head.ts:54-57` resolves a URL only on 2xx/3xx; every other status, 401, 403 and 429 included, fails the reference. `cli-file task` runs the readiness check (`file.ts:516-517`), so one bare URL in task prose to a Cloudflare-protected host blocks filing. Separately, `pipeline-cli/src/dor/gates/gate-3-references.ts:55-56` maps every frontmatter `references:` entry to `kind: 'file-existence'`, so a URL listed in frontmatter is checked as a file path and always fails.

**Failure.** ARC-139 (arcana-website) could not be filed because its prose cited a production URL that returns 403 to non-browser clients.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the check exists to catch dead or mistyped references; a 401/403/429 proves the host exists and refuses robots, not that the link is dead. 2. Deleted: failing on 401, 403 and 429. 3. Simplified: those three statuses resolve as `unverified` with the status in the note, which never blocks; 404, 410 and 5xx still fail. Frontmatter entries that are web addresses go through `classifyUrl` like prose links. 4. Accelerated: none. 5. Automated: tests below.

## Acceptance Criteria

- [ ] #1 A test: a 403 (and 401, 429) reference does not fail gate 3 and is reported as unverified with its status.
- [ ] #2 A test: a 404 reference still fails.
- [ ] #3 A test: a web address entry in frontmatter `references:` is checked as a URL, not a file.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
