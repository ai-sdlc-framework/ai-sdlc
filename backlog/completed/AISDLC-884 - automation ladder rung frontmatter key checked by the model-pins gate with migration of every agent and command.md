---
id: AISDLC-884
title: 'feat(plugin): automation ladder - rung: frontmatter key on every agent and command, checked by the model-pins gate; migration; ladder text names the RFC-0049 judgment layer'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [rfc-0054, phase-1, plugin, governance]
dependencies: []
references:
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - docs/operations/agent-governance-reference.md
  - docs/operations/judgment-layer.md
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
priority: medium
dispatchable: true
---

## Context

RFC-0054 OQ-12 and OQ-13 (resolved 2026-10-14). Rung 2 of the automation ladder is the RFC-0049 System One judgment layer with the provider chosen by configuration (Jev default; a local model or any OpenAI-compatible endpoint through the adapter RFC-0049 ships in shadow); the ladder is enforced by a `rung:` frontmatter key on every agent and command, checked by the existing model-pins gate (`pnpm test:plugin-model-pins-gate`), the structured-key class of check that survived AISDLC-828's deletion of the prose-shape gate (DEC-0158). Velocity impact (DEC-0048): none after a one-time mechanical migration.

## Fix

**Five-step review (requirements first).** Requirement questioned: "the ladder needs a reviewer to enforce it". No: a declared key is checked at rung 0. Deleted: the word "JEV" as a vendor name in the ladder text (replaced by "judgment layer"). Simplified: one key, one gate already in the harness. Accelerated: nothing to accelerate. Automated last: the gate fails only a new or edited file missing a required key.

1. Schema: `rung: 0|1|2|3|4` required on every `ai-sdlc-plugin/agents/*.md` and `ai-sdlc-plugin/commands/*.md`. Rung 2 requires `judgment.question: <typed-question-id>`; rung 3 requires `io.input` and `io.output` (schema file paths) and `bounds` (max calls, max tokens); rung 4 requires `split: {plan: <agent>, execute: <agent>, synthesize: <agent>}`.
2. Gate: extend the model-pins test to validate the key and its rung-specific fields; failure message names the file and the missing field.
3. Migration: add `rung:` to every existing agent and command with the honest value (developer and reviewers 4 with their split named; `review-executor*` 3; deterministic commands 0); list the assignments in `docs/operations/agent-governance-reference.md`.
4. RFC-0054 ladder text and `docs/operations/judgment-layer.md`: rung 2 is "the RFC-0049 judgment layer, provider by config"; document the provider config key and that shadow-first applies to a new provider.
5. Record the follow-up (not done here): a dark-code-style scan of model-call sites with no declaring frontmatter.

## Acceptance Criteria

- [ ] `pnpm test:plugin-model-pins-gate` fails on an agent file without `rung:` and on a `rung: 3` file without `bounds`, naming the file and field; passes on the migrated tree.
- [ ] Every file under `ai-sdlc-plugin/agents/` and `ai-sdlc-plugin/commands/` carries `rung:`; the assignment table is in `docs/operations/agent-governance-reference.md`.
- [ ] `grep -n "JEV" spec/rfcs/RFC-0054-*.md` matches only inside quoted historical text or the Resolution blocks; the normative ladder section says "judgment layer".
- [ ] `docs/operations/judgment-layer.md` documents provider selection by config with Jev as default.

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check`.

## Out of scope

The call-site scan (follow-up); per-rung spend reporting (AISDLC-885).
