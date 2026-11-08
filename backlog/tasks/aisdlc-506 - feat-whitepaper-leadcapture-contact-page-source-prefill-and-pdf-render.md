---
id: AISDLC-506
title: 'feat(ai-sdlc-io): wire whitepaper/website lead-capture to the contact page (source pre-fill) + render whitepaper PDF (AISDLC-496 deferred ACs)'
status: To Do
assignee: []
created_date: '2026-06-03'
labels:
  - marketing
  - whitepaper
  - ai-sdlc-io
  - lead-capture
  - follow-up
dependencies: []
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
permittedExternalPaths:
  - '../ai-sdlc-io/'
priority: medium
dispatchable: true
dispatchableReason: 'Unparked 2026-11-07 by operator ruling. Dependency on AISDLC-496 dropped 2026-11-08 (planner, class a, same shape as AISDLC-1179.1): 496 deliverables shipped (ai-sdlc-io PR #3, whitepaper, PDF) and 496 closes only when this task lands (AC #8), so the dependency was circular and held this task on the board indefinitely.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Completes the two deferred acceptance criteria from AISDLC-496 (the zero-trust untrusted-contributor PR verification whitepaper). The whitepaper and the public website concept page shipped (ai-sdlc-io PR #3, merged), but two pieces were deliberately deferred because they need the ai-sdlc-io design system rather than copy:

1. **Lead-capture → contact page (AISDLC-496 AC#7).** The whitepaper + website page currently end in a "read the whitepaper" CTA and an unfinished operator marker. The operator wants the lead-capture to route to the existing **contact page**, which already emails the operator directly. The contact form must gain a **"where did you come from" / source field** whose value can be **pre-selected via a query parameter**, so a visitor arriving from the whitepaper lands on `/contact?source=...` with the right source already chosen.
2. **Whitepaper PDF (AISDLC-496 AC#11).** Render the whitepaper to a downloadable PDF and link it from the website concept page.

### Current state (verified against ai-sdlc-io source)

- Contact page route: `ai-sdlc-io/src/app/contact/page.tsx`
- Contact form component: `ai-sdlc-io/src/components/contact/contact-form.tsx` — current fields: `name`, `email`, `company`, `teamSize` (select), `aiTools` (checkboxes), `message` (textarea). **No source/referrer field exists yet.**
- Email API route: `ai-sdlc-io/src/app/api/contact/route.ts` — sends the submission to the operator.
- Whitepaper source: `docs/whitepapers/untrusted-contributor-verification.md` in this repository, fetched into ai-sdlc-io by `pnpm docs:fetch` (`.docs-source/docs/whitepapers/`) and served at `/whitepapers/untrusted-contributor-verification`; the PDF already exists at `ai-sdlc-io/public/whitepapers/untrusted-contributor-verification.pdf`.
- Website concept page: route `/docs/concepts/zero-trust-untrusted-pr-verification`, generated from `docs/concepts/zero-trust-untrusted-pr-verification.md` in this repository (the former `content/docs/concepts/zero-trust-pr-verification.mdx` was deleted). Its CTA is a bare whitepaper link.
- Re-verified 2026-11-07: `contact-form.tsx` still has no `source` field; adding it (ACs #1-#3) is the work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `contact-form.tsx` gains a "How did you hear about us / where did you come from" `source` field (a `<select>` consistent with the existing `teamSize` styling). Suggested options (operator may adjust): Whitepaper, Documentation, GitHub, Search engine, Social media, Referral / word of mouth, Other.
- [ ] #2 The `source` value is pre-selectable via a query parameter — `/contact?source=<value>` lands on the form with that option pre-selected (read `searchParams` in `contact/page.tsx` and pass through to the form as a default).
- [ ] #3 The contact email (`api/contact/route.ts`) includes the `source` field in the message delivered to the operator.
- [ ] #4 The whitepaper (`docs/whitepapers/untrusted-contributor-verification.md`) CTA links to `/contact?source=whitepaper` (or the chosen source value).
- [ ] #5 The website concept page (`docs/concepts/zero-trust-untrusted-pr-verification.md`) replaces the bare whitepaper link with a real lead-capture CTA to `/contact?source=...`.
- [x] #6 Dropped 2026-11-07: the whitepaper PDF already exists at `public/whitepapers/untrusted-contributor-verification.pdf`; no render step is needed.
- [ ] #7 ai-sdlc-io build + lint + typecheck clean; no unrelated files touched (the operator has in-flight api-reference / hero.tsx edits in that tree — scope strictly to the lead-capture files).
- [ ] #8 On completion, close out the matching AISDLC-496 deferred AC (#7 lead-capture; #11 PDF is already satisfied) and mark AISDLC-496 done if nothing else remains.
<!-- AC:END -->

## Notes

- This is the follow-up the operator explicitly requested after approving the AISDLC-496 whitepaper drafts: "spin the two deferred ACs into a follow-up task; it should lead to the contact page — the contact page sends emails directly to me, there's a form there with options to pre-select where they came from."
- Source-of-truth files were verified to exist before filing (avoiding the AISDLC-502 doc-vs-code drift class); confirm signatures again at implementation time.
- The ai-sdlc-io working tree may carry unrelated operator changes — branch and stage only the lead-capture files.
- Unparked 2026-11-07 by operator ruling (planner critical-path review). The concept and whitepaper pages are sourced from this repository's `docs/`, so ACs #4 and #5 edit files here; ACs #1-#3 edit ai-sdlc-io (`permittedExternalPaths`).
