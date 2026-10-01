---
id: AISDLC-633.1
title: >-
  RFC-0049 follow-up: harden openai-compatible providerOptions (key allowlist, https, secret-name denylist, caps)
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - judgment-layer
  - security
  - adapter
dependencies:
  - AISDLC-633
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Security review of AISDLC-633 (#1128): `providerOptions` is free-form, so a config can
set `fetchImpl` or environment-shaped keys, point at an http host, or name a
secret-bearing env var as `apiKeyEnv`. Must land before any `openai-compatible`
provider is configured in a repository.

## Scope
1. Accept only an allowlisted key set in `providerOptions.openai-compatible`:
   `baseUrl`, `model`, `apiKeyEnv`, `timeoutMs`, `maxRetries`, `maxResponseBytes`,
   `maxStateTokens`, `inputCostPer1MTokens`, `outputCostPer1MTokens`. Any other key
   fails config validation and the layer runs disabled for that provider.
2. Require `https` for any non-loopback `baseUrl`, and for every `baseUrl` when
   `apiKeyEnv` is set.
3. Reject `apiKeyEnv` values on a denylist of secret-bearing names that are not
   provider keys (for example `GITHUB_TOKEN`, `NPM_TOKEN`, `AI_SDLC_PAT`,
   `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, `AWS_SECRET_ACCESS_KEY`) and any name
   ending in `_PRIVATE_KEY`.
4. Cap `maxRetries` (default 2, max 5) and `maxResponseBytes` (default 1 MiB, max
   8 MiB); abort a response that exceeds the cap with kind `bad-response`.

## Acceptance Criteria
- [ ] A config with an unknown providerOptions key is rejected and the provider is reported disabled with the key named.
- [ ] An http non-loopback host is rejected; an http loopback host without a key is accepted; an http loopback host with a key is rejected.
- [ ] Each denylisted `apiKeyEnv` name is rejected; a provider-key name is accepted.
- [ ] A response larger than `maxResponseBytes` yields kind `bad-response`, and `maxRetries` above the cap is clamped with a logged warning.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
