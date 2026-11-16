---
id: AISDLC-1264
title: 'DoR Gate 3 extracts false URLs from inline-code config keys and quoted text, so a valid task filing is refused'
status: Done
assignee: []
created_date: '2026-11-13'
labels:
  - pipeline-cli
  - dor
  - bug
dependencies: []
references:
  - pipeline-cli/src/dor/resolvers/index.ts
  - pipeline-cli/src/dor/resolvers/index.test.ts
priority: medium
dispatchable: true
dispatchableReason: 'Reproduced 2026-11-11 filing AISDLC-1262: Gate 3 reported the GitHub origin with `.helper` appended and the GitHub origin with a trailing double quote as unresolvable. Both come from the bare-URL regex in extractReferences(); the fix is a few lines plus two unit tests. Reserved as the subject of the ai-sdlc.io home-page demo recording (site task IO-48): filed with --no-brief on purpose; do NOT write a brief for it, the demo run writes its own.'
---

## Description

**Gap.** `extractReferences()` in `pipeline-cli/src/dor/resolvers/index.ts` finds bare URLs with `(?<!\()(https?:\/\/\S+)` and then strips only `)`, `,`, `.`, `;` and `:` from the end of the match. Two real task bodies tripped it on 2026-11-11:

- A git config key written in inline code, `credential.<scheme>://github.com.helper` (with `https` as the scheme), yields a reference to `github.com.helper` with the scheme attached. The match starts in the middle of a word.
- A quoted error message, "could not read Username for" followed by the GitHub origin URL and a closing double quote, yields that URL with the quote attached.

Both references fail the HEAD check, Gate 3 refuses the filing, and the author has to reword prose that was correct.

**Shape.** Two small changes to the bare-URL pass, each with a unit test next to the existing `strips trailing punctuation from bare URLs` case:

1. Require the scheme to start at a word boundary that is not a `.` or `/` (do not match a URL embedded in a longer dotted token).
2. Extend the trailing-strip set with `"`, `'` and `` ` ``.

Markdown-link extraction (pass 1) is unchanged.

## Fix

**Five-step review.**
1. Requirement questioned: Gate 3 must still resolve real bare URLs; the change only narrows what counts as one.
2. Deleted: nothing.
3. Simplified: one regex tweak and one widened character class; no new module.
4. Accelerated: n/a.
5. Automated: the two unit tests keep the regression from returning.

## Acceptance Criteria

- [ ] #1 `extractReferences('key `credential.<scheme>://github.com.helper` (with `https` as the scheme)')` returns no `url` reference.
- [ ] #2 `extractReferences() on a body quoting the GitHub origin URL followed by a closing double quote` returns the origin URL without the quote as the only `url` reference.
- [ ] #3 Existing `index.test.ts` cases still pass, including the trailing-punctuation case and the markdown-link case.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
