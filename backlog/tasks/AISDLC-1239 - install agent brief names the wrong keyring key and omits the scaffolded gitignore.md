---
id: AISDLC-1239
title: 'Install agent brief: keyring block is `reviewers:` not `signingKeys:`, and the commit step must include the scaffolded .gitignore'
status: To Do
assignee: []
created_date: '2026-11-08'
labels:
  - docs
  - onboarding
  - install
  - bug
dependencies: []
references:
  - docs/getting-started/install-agent-brief.md
  - docs/getting-started/onboarding.md
  - docs/ucvg-test-repo-setup/signing-key-setup.md
  - .ai-sdlc/trusted-reviewers.yaml
  - scripts/smoke-install-brief.mjs
priority: medium
dispatchable: true
dispatchableReason: 'Filed by the planner on operator order 2026-11-08 from the first real passing run of scripts/smoke-install-brief.mjs (AISDLC-1236 AC #2, PR #2556): the installing agent had to deviate from the brief twice. Docs-only fix, no code.'
---

## Description

**Observed 2026-11-08 (operator machine, AISDLC-1236 AC #2 run).** `node scripts/smoke-install-brief.mjs` drove `claude -p` through `docs/getting-started/install-agent-brief.md` in a fresh repo. The doctor passed (25 pass, 2 warn, 0 fail) but the agent reported two places where the brief does not match the framework it installs:

1. Step 5 tells the agent to paste the public key "under `signingKeys:`" in `.ai-sdlc/trusted-reviewers.yaml`. The file the scaffold writes, and the schema `trusted-reviewers` doctor check validates, use `reviewers:` (see this repository's `.ai-sdlc/trusted-reviewers.yaml` line 64). The agent noticed and followed the file; a less careful agent writes a key the verifier never reads. `docs/getting-started/onboarding.md` (steps 5 and the block near line 249) and `docs/ucvg-test-repo-setup/signing-key-setup.md` (line 68) repeat the stale key name.
2. The commit step (`git add .ai-sdlc .github CLAUDE.md package.json pnpm-lock.yaml`) omits the scaffolded `.gitignore`, which is what keeps runtime state such as `state.db` and `.ai-sdlc/artifacts/` out of the repository (`runtime-gitignore` doctor check). The agent left it untracked and said so. `.mcp.json` is also scaffolded and left out; decide whether it belongs in the list (it is committed in this repository).

## Fix

**Five-step review (requirements first).**
1. Question: does the brief need to name the keyring key at all? Yes: a scripted agent has no other way to know where the public key goes.
2. Delete: the duplicated step-5 text in `onboarding.md` and the brief should come from one place; if the two files are generated from the same source, fix the source, otherwise fix both and add a one-line test that the two step-5 texts match.
3. Simplify: replace `signingKeys:` with `reviewers:` and show the exact block shape the `trusted-reviewers` check accepts (the `addedBy` field included, so the agent does not guess a login). Add `.gitignore` (and `.mcp.json` if kept) to the `git add` list.
4. Accelerate: none.
5. Automate: extend `scripts/smoke-install-brief.mjs` (or its test) to grep the brief for `signingKeys:` and fail, so the stale name cannot return.

## Acceptance Criteria

- [ ] AC-1: `grep -rn signingKeys docs/` returns nothing; every doc that showed the key block shows `reviewers:` with the schema's field names.
- [ ] AC-2: the brief's commit step lists `.gitignore`; the PR body states the decision on `.mcp.json` in one sentence.
- [ ] AC-3: a check (test or smoke-script assertion) fails when the brief names a key that is not in the `trusted-reviewers` schema.
- [ ] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
