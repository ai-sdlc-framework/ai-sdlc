---
id: AISDLC-633.2
title: >-
  RFC-0049 follow-up: apiKeyEnv name rule beyond the fixed denylist, caps on timeoutMs and maxStateTokens, sanitised disabled reasons
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - rfc-0049
  - judgment-layer
  - security
  - reference
dependencies:
  - AISDLC-633.1
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/judgment/openai-compatible-provider.ts
  - docs/operations/judgment-layer.md
priority: low
dispatchable: false
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parked (planner, 2026-10-06): do not start without a planner go.

Security-reviewer findings parked from AISDLC-633.1 (PR #1149), operator-approved
for filing 2026-10-02. They close before any adopter configures a real
`openai-compatible` provider.

## Conventions
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- Hermetic tests: the provider takes `env` through its `deps` argument, never
  `process.env`.
- Keep the allowlist validator as the single place options are checked.

## Scope
1. **`apiKeyEnv` rule:** the fixed denylist misses `GH_TOKEN`, `NODE_AUTH_TOKEN`,
   `AWS_SESSION_TOKEN`, `ACTIONS_*`, `*_SECRET`, `*_PASSWORD` and similar. Replace or
   extend it with a rule: the name must end in `_KEY` or `_API_KEY`, must not start
   with `ACTIONS_`, `GITHUB_`, `AWS_`, `NPM_`, `NODE_`, `AI_SDLC_`, and must not match
   `*_SECRET*`, `*_TOKEN*`, `*_PASSWORD*`, `*_PRIVATE_KEY`. The existing denylist
   entries stay as explicit tests.
2. **Caps:** `timeoutMs` default 10 000, cap 120 000; `maxStateTokens` default 8 000,
   cap 32 000; both clamped with a warning through `deps.warn`, like `maxRetries`.
3. **Reason sanitising:** an unknown option key echoed into the disabled reason is
   truncated to 64 characters and non-printable characters are replaced before it is
   returned; the same applies to any config-derived string that reaches a reason.
4. **Docs:** `docs/operations/judgment-layer.md` documents the name rule, the two
   caps, and the existing `baseUrl` refusal of `@` and backslash anywhere in the URL.

## Acceptance Criteria
- [ ] `GH_TOKEN`, `ACTIONS_RUNTIME_TOKEN`, `DB_PASSWORD`, `APP_SECRET` and every prior denylist entry are rejected; `OPENAI_API_KEY`, `MY_PROVIDER_KEY` are accepted.
- [ ] `timeoutMs: 600000` is clamped to 120 000 with one warning; `maxStateTokens: 100000` is clamped to 32 000 with one warning.
- [ ] An unknown key containing control characters or longer than 64 characters produces a reason with neither.
- [ ] The docs table lists the name rule, both caps and the `baseUrl` character rule.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
