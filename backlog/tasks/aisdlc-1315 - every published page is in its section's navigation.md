---
id: AISDLC-1315
title: 'Every published page is in its section''s navigation'
status: To Do
assignee: []
created_date: '2026-11-18'
labels:
  - docs
  - docs-platform
dependencies:
  - AISDLC-1313
references:
  - scripts/check-docs-nav.mjs
  - scripts/check-docs-nav.test.mjs
  - docs/meta.json
  - docs/concepts/meta.json
  - docs/getting-started/meta.json
  - docs/whitepapers/meta.json
  - docs/README.md
  - docs/concepts/adopter-translators.md
  - docs/concepts/design-review-architecture.md
  - docs/concepts/spec-driven.md
  - docs/concepts/substrate-contract.md
  - docs/concepts/untrusted-contributor-verification.md
  - docs/concepts/variants.md
  - docs/getting-started/install-agent-brief.md
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-18: "file those docs tasks", after the planner''s audit of completed RFCs against the published documentation. The seven missing pages were found by comparing each `meta.json` with its directory on `main` at b56cecaee on 2026-11-18. The dependency is listed because AISDLC-1313 edits `docs/concepts/meta.json` and leaves two retired pages that this task''s check must know about.'
---

## Description

**Gap.** The website builds its sidebar from the `meta.json` files of this repository (AISDLC-854). A page that exists in a published directory but is not named in that directory's `meta.json` has a URL and no sidebar entry. On `main`:

- `docs/concepts/meta.json` names 14 pages; the directory has 20. Missing: `adopter-translators`, `design-review-architecture`, `spec-driven`, `substrate-contract`, `untrusted-contributor-verification`, `variants`. Each has frontmatter `title` and `description`. None is in the table of `docs/concepts/index.md` either.
- `docs/getting-started/meta.json` names `index`, `onboarding`, `mcp-advisor-setup`; `install-agent-brief.md` is missing.
- `docs/whitepapers/` has its own `meta.json` (two pages), but `docs/meta.json` does not name `whitepapers`. `docs/README.md` line 15 links the folder. Whether the omission is deliberate cannot be read from this repository: the completed task AISDLC-854 copied the site's navigation as it was on that day, and that navigation had no white papers entry; the site renders white papers and their PDFs with its own code.
- `docs/api-reference/meta.json`, `docs/tutorials/meta.json` and `spec/meta.json` name every page of their directory (checked 2026-11-18).

The existing check, `scripts/check-docs-nav.mjs` (AISDLC-854, run by `scripts/check-docs-nav.test.mjs` under `pnpm test:gates`), tests one direction only: every name in a `meta.json` resolves to a file or directory. It passes today (`check-docs-nav: 7 navigation files valid`). Nothing tests that every file is named.

**Shape.** The seven pages are in their sidebars, and `check-docs-nav` fails when a page of a published directory is named by no `meta.json` and no recorded exception.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must every file be in the sidebar? No: a retired page kept for inbound links and a folder the site renders by other means are legitimate exceptions, so the rule is "named in `meta.json` or in a list with a reason", not "named in `meta.json`". 2. Deleted: nothing. 3. Simplified or optimised: the existing script gains the reverse direction; no second script and no new package script. 4. Accelerated: not applicable. 5. Automated: the check runs in `pnpm test:gates`, which the gate workflow and the root `test` script already run.

- **Navigation.** Add the six concept pages to `docs/concepts/meta.json`, each next to the page of the same subject (for example `untrusted-contributor-verification` after `zero-trust-untrusted-pr-verification`, `variants` and `substrate-contract` after `per-repo-governance`). Add `install-agent-brief` to `docs/getting-started/meta.json` after `onboarding`. Keep the entries that are there in their order.
- **Check.** `scripts/check-docs-nav.mjs`, in `checkNav` or a second exported function called by `main` and by the repository test:
  - for the directory of each file of `NAV_FILES`, every `*.md` and `*.mdx` file directly in it must be named in `pages` (name without extension); `README.md` and `index.md` count as `index`;
  - a sub-directory that has its own file in `NAV_FILES` must be named in the `pages` of its parent directory's `meta.json` when the parent has one;
  - an exported map `UNLISTED` (`path` to reason, the shape of `ALLOWLIST` in `scripts/check-docs-retired-terms.test.mjs`) exempts a path; an entry whose path does not exist, or that is named in a `meta.json`, is an error, so the map only shrinks.
  - Error lines keep the form `check-docs-nav: <meta.json>: ...` and name the file to add.
- **Exceptions recorded, not decided.** `UNLISTED` starts with `docs/whitepapers` (reason: the site renders white papers outside the docs sidebar; the omission predates AISDLC-854 and is unconfirmed) and with the pages that AISDLC-1313 keeps as retired stubs outside the sidebar (`docs/concepts/autonomous-orchestrator.md`, `docs/concepts/operator-tui.md`, if they exist on the base tree and are not in `meta.json`). The PR body asks the operator whether `whitepapers` belongs in `docs/meta.json`; this task does not add it.
- **Tests.** `scripts/check-docs-nav.test.mjs`: a fixture for each new error (a file not named, a sub-directory with a `meta.json` not named by its parent, an `UNLISTED` entry with no file, an `UNLISTED` entry that is also named) and for the two passing cases (`README.md` as `index`, an exempted path). The existing test `repository navigation files are valid` stays and passes.
- **Stop rule.** If the check finds an unnamed page that this task does not list, do not add it to `UNLISTED` on your own judgment: add it to `meta.json` when it has frontmatter `title` and `description` and is not marked retired, otherwise report it in the verdict notes and stop.

Out of scope: the content of any page; `docs/concepts/index.md`; merging `untrusted-contributor-verification.md` with `zero-trust-untrusted-pr-verification.md` (two pages on one subject; named in the PR body for the planner); directories without a `meta.json` (`docs/operations/`, `docs/audits/`, `spec/rfcs/` and the others); the site repository.

## Acceptance Criteria

- [ ] #1 `docs/concepts/meta.json` names `adopter-translators`, `design-review-architecture`, `spec-driven`, `substrate-contract`, `untrusted-contributor-verification` and `variants`; `docs/getting-started/meta.json` names `install-agent-brief`; no entry present on the base tree is removed or reordered.
- [ ] #2 `node scripts/check-docs-nav.mjs` exits 1 and names the file when a `.md` or `.mdx` file directly in the directory of a `NAV_FILES` entry is named by neither its `meta.json` nor `UNLISTED`; a test asserts it on a fixture.
- [ ] #3 The check fails when a sub-directory with its own `NAV_FILES` entry is named by neither the parent `meta.json` nor `UNLISTED`; a test asserts it.
- [ ] #4 The check fails on an `UNLISTED` entry whose path does not exist and on one that a `meta.json` also names; a test asserts each case.
- [ ] #5 The check still fails when a `meta.json` names a page that does not exist; the existing test for it is unchanged.
- [ ] #6 `UNLISTED` contains `docs/whitepapers` with a reason and at most the two retired pages named above; `docs/meta.json` is not in the diff; the PR body puts the white papers question to the operator.
- [ ] #7 `node scripts/check-docs-nav.mjs` and `node --test scripts/check-docs-nav.test.mjs` pass on the PR head.
- [ ] #8 The diff contains only `scripts/check-docs-nav.mjs`, `scripts/check-docs-nav.test.mjs`, `docs/concepts/meta.json`, `docs/getting-started/meta.json` and this task file.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
