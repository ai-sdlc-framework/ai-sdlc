---
id: AISDLC-622
title: Ollama support via generic-llm — env preset + docs + integration test (closes #966)
status: Done
priority: medium
labels:
  - runners
  - orchestrator
  - docs
  - adopter-facing
created: 2026-09-17
---

## Context

Delivers GitHub issue #966 (external feature request: "Implement AgentRunner for
Ollama, supporting Gemma 4"). The community PR #998 attempted this by adding a
`gemma` alias to the Claude-Code model registry — the wrong layer. The correct
approach (per maintainer analysis on #998/#966): **no new runner is needed.**
Ollama already exposes an OpenAI-compatible endpoint
(`http://localhost:11434/v1/chat/completions`) that the existing
`GenericLLMRunner` (`orchestrator/src/runners/generic-llm.ts`) speaks. The
generic-llm runner already registers from `LLM_API_URL` + `LLM_API_KEY` +
`LLM_MODEL` (`runner-registry.ts` `discoverFromEnv`).

So Ollama works TODAY with three env vars. This task makes it first-class and
discoverable: a named `ollama` env preset (mirroring the existing `openai` /
`anthropic` presets), documentation, and an integration test. Plus it salvages
the one genuinely-good change from PR #998.

## Scope

1. **`ollama` env preset in `runner-registry.ts` `discoverFromEnv`** — mirror the
   existing `openai`/`anthropic` preset blocks (lines ~159-186). Register a named
   `ollama` runner (backed by `GenericLLMRunner`) when an Ollama-selecting env var
   is set (e.g. `OLLAMA_MODEL`, or `LLM_PROVIDER=ollama`), defaulting
   `apiUrl` to `http://localhost:11434/v1/chat/completions` (overridable via
   `OLLAMA_API_URL`/`OLLAMA_HOST`), `apiKey` to a non-empty placeholder (Ollama
   ignores it), and `model` from `OLLAMA_MODEL` (e.g. `gemma4:31b`). Add
   corresponding `DEFAULT_OLLAMA_*` constants in `defaults.ts` following the
   `DEFAULT_OPENAI_*`/`DEFAULT_ANTHROPIC_*` convention. Do NOT touch the
   Claude-Code model registry (`models/registry.ts`) — that is the wrong layer.
2. **Docs** — add an "Ollama (local models)" section to
   `docs/api-reference/runners.md` (and a short pointer in
   `docs/getting-started/README.md`) with the working recipe. Both the generic
   3-env-var form AND the new preset form:
   ```bash
   # Generic form (works today):
   export LLM_API_URL=http://localhost:11434/v1/chat/completions
   export LLM_API_KEY=ollama          # any non-empty value; Ollama ignores it
   export LLM_MODEL=gemma4:31b
   # Or the ollama preset:
   export OLLAMA_MODEL=gemma4:31b      # defaults the localhost URL
   ```
   Explain that Gemma (and any Ollama model) runs via the OpenAI-compatible path,
   NOT via a Claude-Code alias.
3. **Integration test** — a Vitest integration test against `GenericLLMRunner` /
   the `ollama` preset that is SKIPPED unless `LLM_API_URL` (or `OLLAMA_MODEL`) is
   set (`describe.skipIf`/`it.skipIf`), so CI stays hermetic but a developer with
   Ollama running can exercise the real path. PLUS a hermetic unit test asserting
   the `ollama` preset registers with the correct defaulted apiUrl/model.
4. **Salvage from PR #998** — apply the `fileURLToPath(import.meta.url)` fix in
   `orchestrator/src/cli/commands/init-compliance-wizard.test.ts` (replacing
   `new URL().pathname`) — a real cross-platform correctness fix. Credit the
   original contributor (NathanDotTo, #998) in the commit body.
5. Do NOT add any `backlog/tasks/aisdlc-550*` file (the #998 one collided with an
   existing task and was invalid).

## Acceptance Criteria

- [x] AC-1: With `OLLAMA_MODEL` set (and no other runner env), `discoverFromEnv`
      registers a named `ollama` runner backed by GenericLLMRunner with apiUrl
      defaulted to the Ollama localhost endpoint and model = `OLLAMA_MODEL`.
      Overridable via `OLLAMA_API_URL`/`OLLAMA_HOST`. Hermetic unit test proves it.
- [x] AC-2: The Claude-Code model registry (`models/registry.ts`) is UNCHANGED —
      no `gemma` alias added there.
- [x] AC-3: `docs/api-reference/runners.md` documents the Ollama recipe (both
      generic 3-env-var and preset forms); getting-started points to it.
- [x] AC-4: A skipped-unless-configured integration test exists against the
      generic-llm/ollama path; the hermetic unit tests cover the preset defaults.
- [x] AC-5: The `fileURLToPath` cross-platform fix from #998 is applied to
      `init-compliance-wizard.test.ts`.
- [x] AC-6: `pnpm build && test && lint && format:check` clean; patch coverage
      >= 80% on changed orchestrator code. PR body includes `Closes #966` and
      credits #998's author for the salvaged fix.

## References

GitHub issue #966; community PR #998 (redirected). Code:
`orchestrator/src/runners/generic-llm.ts`, `orchestrator/src/runners/runner-registry.ts`
(`discoverFromEnv`), `orchestrator/src/defaults.ts`, `docs/api-reference/runners.md`.
