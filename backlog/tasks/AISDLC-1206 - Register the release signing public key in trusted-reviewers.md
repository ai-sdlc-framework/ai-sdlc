---
id: AISDLC-1206
title: 'Register the release signing public key in trusted-reviewers'
status: In Progress
assignee: []
created_date: '2026-11-06'
labels:
  - release signing
  - governance config
dependencies: []
references:
  - .ai-sdlc/trusted-reviewers.yaml
  - pipeline-cli/src/dor/trusted-reviewers-check.ts
  - .github/workflows/release.yml
priority: high
dispatchable: true
---

## Description

**Source.** Operator instruction 2026-11-06 (planner session). Affected surface: `.ai-sdlc/trusted-reviewers.yaml` (trust chain config, tightening only).

`AISDLC_SIGNING_KEY` was never provisioned, so `release.yml` soft-skipped MCP tarball signing on every release: zero `mcp-server-*.dsse.json` envelopes exist and the SessionStart verifier only ever warned "attestation missing". On 2026-11-06 the operator generated an ed25519 key, set the `AISDLC_SIGNING_KEY` repository secret and keeps the private key outside the repository (DEC-0378: the old `AISDLC_SIGNING_KEY_CONTENT` secret is deleted). The matching public key is not yet in `.ai-sdlc/trusted-reviewers.yaml`, so a signed release would verify against no trusted key.

The operator-directed PR #2443 carries the exact change but cannot land: it names no task (`ai-sdlc/issue-link` fails) and no pipeline round produced a verdict ref for it, and branch protection enforces admins. This task is the sanctioned path; #2443 closes as byte-identical once this lands (DEC-0266).

**Ordering.** Must land before the release PR #2250 merges, or the next release signs with a key no verifier trusts.

## Fix

**Five-step review (requirements first).**
1. *Question the requirement.* Signing the MCP tarball is the DEC-0001 / AISDLC-439 control; a signature nobody can verify is noise. The public key must be in the trust file.
2. *Delete.* Nothing.
3. *Simplify.* One appended entry under `reviewers:`, in the strict format the hand-rolled loader (`trusted-reviewers-check.ts`) parses; no loader change.
4. *Accelerate.* None.
5. *Automate.* The existing loader tests cover the format; add one fixture assertion that the `release-bot@ai-sdlc.io` entry parses to the expected key.

Append this entry to the `reviewers:` list in `.ai-sdlc/trusted-reviewers.yaml`, immediately after the last existing entry and before the RFC-0043 author-allowlist section:

```yaml
  - identity: 'release-bot@ai-sdlc.io'
    machine: 'ci-runner'
    addedAt: '2026-11-06'
    addedBy: 'deefactorial'
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      MCowBQYDK2VwAyEA4ffdPxGoKLIfEMkfkLMlrp8YtJ5wmn+dVv3CJJhLGlQ=
      -----END PUBLIC KEY-----
```

The key bytes are authoritative as written above (they match PR #2443). Change nothing else in the file.

## Acceptance Criteria
- [ ] #1 `.ai-sdlc/trusted-reviewers.yaml` contains the `release-bot@ai-sdlc.io` entry with exactly the public key above and the loader parses it (existing tests plus one fixture assertion).
- [ ] #2 No other line of the file changes; `pnpm test` for pipeline-cli passes.
- [ ] #3 PR body names PR #2443 as the superseded operator-directed PR and states the ordering constraint against release PR #2250.
