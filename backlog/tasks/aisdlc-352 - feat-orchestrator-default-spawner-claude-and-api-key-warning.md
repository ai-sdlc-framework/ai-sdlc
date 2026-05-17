---
id: AISDLC-352
title: 'feat(orchestrator): default `cli-orchestrator tick` spawner to `claude` + warn when ANTHROPIC_API_KEY is set'
status: To Do
assignee: []
created_date: '2026-05-17'
labels:
  - orchestrator
  - billing-safety
  - operator-ergonomics
dependencies:
  - AISDLC-349
priority: high
references:
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/docs/spawner.md
  - docs/operations/billing-and-cost-optimization.md
---

## Bug / friction

Two related footguns:

### 1. Default `--spawner` is `claude-cli` (manifest mode) — silent fail from shell

`cli-orchestrator tick` (without explicit `--spawner`) defaults to `claude-cli` which writes a dispatch manifest expecting a calling slash command body to read it. From a plain shell that fails silently with `developer-json-contract-violated`. Per AISDLC-349, the working option for shell-driven dispatch is `--spawner claude` — but operators must remember to pass the flag.

### 2. `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` is the silent escape valve

If the env var is set (and `ANTHROPIC_API_KEY` is present), `--spawner claude-cli` will silently fall back to `api-key` (Anthropic SDK + paid API tokens). The operator gets a working tick but the billing path silently switched from subscription → API tokens. No warning, no log.

This is a real billing-safety issue: a single env-var setting (probably set months ago for an old fallback) can cause every autonomous tick to draw API tokens without operator awareness.

## Acceptance criteria

### Default spawner

- [ ] **Change `cli-orchestrator tick`'s default `--spawner` from `claude-cli` to `claude`** in `pipeline-cli/src/orchestrator/cli-tick.ts` (or wherever yargs defaults live). This makes the shell-driven path "just work" without operator-supplied flags.
- [ ] **Keep `--spawner claude-cli`** as an explicit choice for the `/ai-sdlc orchestrator-tick` slash command body path (which IS the subscription-preserving path post-2026-06-15 — see AISDLC-353 follow-up).
- [ ] **Update `pipeline-cli/docs/spawner.md`** + CLAUDE.md to reflect the new default + when to deviate.

### `ANTHROPIC_API_KEY`-set warning

- [ ] **When `cli-orchestrator tick --spawner claude` is invoked AND `ANTHROPIC_API_KEY` is set in env**, emit a one-line warning to stderr:
   ```
   [orchestrator] warning: ANTHROPIC_API_KEY is set but --spawner claude is requested.
   If the dispatch falls back to --spawner api-key for any reason, you'll be billed
   for paid API tokens. To force subscription-only, unset ANTHROPIC_API_KEY before
   running the tick.
   ```
- [ ] **Same warning when `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key`** AND the spawner is anything other than `api-key`. Make the silent-fallback path explicit.
- [ ] **Test coverage**: assert the warning fires under both conditions; assert it does NOT fire when `ANTHROPIC_API_KEY` is unset and no fallback is configured.

### Documentation

- [ ] **`docs/operations/billing-and-cost-optimization.md`** — add a "Billing-safety checklist" section:
   - Always pass `--spawner claude` explicitly (or now: rely on the new default)
   - Unset `ANTHROPIC_API_KEY` in the tick's shell (or the parent shell env) unless you actually want API billing
   - Watch for the warning line
- [ ] **CLAUDE.md** — Canonical execution paths table gains a "Billing" column making the subscription / Agent SDK credit / API-key split explicit per spawner kind.

## Out of scope

- The subscription-preserving slash-command-body path (AISDLC-353 — separate)
- Removing the `api-key` fallback entirely (operators with API-key-only environments still need it)

## Source

Operator concern 2026-05-17: prior review (pre-AISDLC-349) found the autonomous tick was running on API tokens, not subscription. Now post-AISDLC-349 the subscription path exists via `--spawner claude` but operators must remember the flag + must not have `ANTHROPIC_API_KEY` accidentally enabling the fallback. The default + warning close both footguns.
