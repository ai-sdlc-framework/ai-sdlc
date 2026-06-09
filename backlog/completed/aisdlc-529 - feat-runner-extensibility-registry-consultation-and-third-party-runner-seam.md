---
id: AISDLC-529
title: >-
  feat(orchestrator): runner extensibility — consult runner-registry in
  execute.ts + third-party runner extension point (--runner / AI_SDLC_RUNNER_PLUGIN)
status: In Progress
assignee: []
labels:
  - enhancement
  - adopter-experience
  - ci:no-issue-required
dependencies: []
priority: high
references:
  - orchestrator/src/execute.ts
  - orchestrator/src/runners/runner-registry.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
External contributor (GitHub #870) wants to run a non-Claude AgentRunner (Kiro CLI headless) through the standard `ai-sdlc` command without patching the package. Today that is impossible cleanly:

- `orchestrator/src/execute.ts:745` hardcodes the fallback `const runner = options.runner ?? new ClaudeCodeRunner();` — it never consults the runner registry, so even env-discovered runners are bypassed.
- `orchestrator/src/runners/runner-registry.ts` HAS a `RunnerRegistry` with `register()` + `discoverFromEnv()` (it already auto-registers OpenAI / Anthropic / generic-LLM runners from env), but there is **no third-party extension point** (no way to register a custom runner binary) and **no `--runner` flag** to select one.

This task adds the runner seam so an adopter can supply their own AgentRunner. **This is the prerequisite for the external Kiro PR** (GitHub #870): once this seam exists, the contributor submits `KiroRunner` as a thin consumer that plugs into it (that PR is intentionally NOT part of this task — it will come in via the untrusted-contributor PR flow / RFC-0043 gate).

Required behavior (shape pinned to the contributor's proposal + existing primitives — do not redesign without escalating):

1. **Consult the registry in execute.ts.** Replace the hardcoded `new ClaudeCodeRunner()` fallback with: use `options.runner` if injected; else resolve from the runner registry (after `discoverFromEnv()`), selecting by an explicit selector (see #2); else fall back to `ClaudeCodeRunner` as the default when no selector/registration applies. ClaudeCodeRunner stays the default — this only adds the registry path.
2. **Selector surface.** Add a `--runner <name>` flag to `ai-sdlc run` AND an `AI_SDLC_RUNNER_PLUGIN=/path/to/runner.(m)js` env var that dynamically imports a module exporting an `AgentRunner` (registered into the registry under a name). Precedence: explicit `--runner` > `AI_SDLC_RUNNER_PLUGIN` > env-discovered (existing) > `ClaudeCodeRunner` default.
3. **Clear errors.** If `--runner <name>` names an unregistered runner, or `AI_SDLC_RUNNER_PLUGIN` points at a module that doesn't export a valid AgentRunner, fail fast with an actionable message (not a silent fallback that hides the misconfig).
4. **Docs.** Update the runners doc (`ai-sdlc.io/docs/api-reference/runners` source) to document the `--runner` flag + `AI_SDLC_RUNNER_PLUGIN` extension point.

The `AgentRunner` interface is already the contract — this task does NOT change it; it only wires selection + a load path. If the precise API shape (flag name, env var name, plugin module export contract) is genuinely ambiguous beyond the proposal above, return `prUrl: null` with a notes-escalation rather than guessing — this is adopter-facing API.

Scope: `orchestrator/` (execute.ts wiring, run command flag, registry extension) + the runners doc. Do NOT implement KiroRunner.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 execute.ts resolves the runner via the registry (after discoverFromEnv) instead of hardcoding `new ClaudeCodeRunner()`; ClaudeCodeRunner remains the default when no selector/registration applies; `options.runner` injection still wins (no test regression)
- [ ] #2 `ai-sdlc run --runner <name>` selects a registered runner; `AI_SDLC_RUNNER_PLUGIN=/path/to/runner.mjs` dynamically loads + registers a custom AgentRunner; documented precedence is --runner > AI_SDLC_RUNNER_PLUGIN > env-discovered > ClaudeCodeRunner default
- [ ] #3 An unregistered `--runner` name or an invalid AI_SDLC_RUNNER_PLUGIN module fails fast with an actionable error (no silent fallback that hides the misconfiguration)
- [ ] #4 The AgentRunner interface contract is unchanged; the runners doc documents --runner + AI_SDLC_RUNNER_PLUGIN
- [ ] #5 Hermetic tests cover: registry-resolved runner, --runner selection, AI_SDLC_RUNNER_PLUGIN load (happy + invalid), and ClaudeCodeRunner default fallback; pnpm build + pnpm -F @ai-sdlc/orchestrator test + lint + format:check pass
<!-- AC:END -->
