---
id: AISDLC-530
title: >-
  feat(orchestrator): resolve source-control adapter from adapter-binding.yaml
  (unhardcode GitHub; wire GitLab; local-only mode)
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
  - orchestrator/src/adapters.ts
  - reference/src/adapters/gitlab/index.ts
  - .ai-sdlc/adapter-binding.yaml
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
External contributor (GitHub #870) runs on **GitLab self-hosted** and also wanted **local-only** (no remote) for testing. Both are blocked because `orchestrator/src/execute.ts:322` hardcodes the source-control adapter: `const sc = options.sourceControl ?? createGitHubSourceControl(ghConfig);`. There is an `options.sourceControl` injection point (programmatic/testing only) but no config-driven way to switch — even though a GitLab adapter already exists (`reference/src/adapters/gitlab/index.ts`) and the repo already has an `AdapterBinding` config kind (`.ai-sdlc/adapter-binding.yaml`). For a GitLab user this forces a fork; for a local user it causes an immediate Connect Timeout against api.github.com.

This task makes source-control resolution config-driven, using primitives that already exist (do not invent a new config kind — use the existing `AdapterBinding`):

1. **Resolve from `adapter-binding.yaml`.** In execute.ts, replace the hardcoded `createGitHubSourceControl` fallback with: use `options.sourceControl` if injected; else read the `AdapterBinding` whose `spec.interface: SourceControl` and construct the adapter for its `spec.type` (`github` → existing GitHub adapter, `gitlab` → wire the existing `reference/src/adapters/gitlab` adapter); else default to GitHub (current behavior) so existing GitHub users are unaffected. Resolve `spec.config` (url, token via secretRef) for self-hosted instances (e.g. `https://gitlab.internal.company.com`).
2. **Local-only mode.** When there is no remote (or an explicit local mode), the pipeline must not attempt GitHub/GitLab API calls — the `push` and `create-pr` steps should gracefully skip (as they already do for `push` in the contributor's local run) rather than time out. Prefer auto-detection of a missing remote; an explicit signal (e.g. a `local` adapter type or `--local` flag) is acceptable if cleaner. Coordinate the no-remote git behavior with AISDLC-527 (git-remote guard).
3. **GitLab wiring completeness.** Ensure the existing GitLab adapter is actually constructable from `AdapterBinding` config end-to-end (PR/MR create, etc., to the extent the pipeline uses it). If the GitLab adapter has gaps that block the happy path, document them in notes rather than silently shipping a half-wired path.
4. **Docs.** Document the `adapter-binding.yaml` SourceControl selection (github / gitlab / local) with the self-hosted GitLab example from the contributor's proposal.

This defines adopter-facing config behavior. The shape is pinned to the existing `AdapterBinding` kind + the contributor's proposed `adapter-binding.yaml` example. If resolution semantics are genuinely ambiguous (e.g. multiple SourceControl bindings, precedence vs `options.sourceControl`), return `prUrl: null` with a notes-escalation rather than guessing.

Scope: `orchestrator/` (execute.ts + adapters resolution) + reference GitLab adapter wiring + docs. Existing GitHub-based flows MUST be unchanged when no SourceControl AdapterBinding is present (default stays GitHub).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 execute.ts resolves the source-control adapter from the `AdapterBinding` (`spec.interface: SourceControl`) in `.ai-sdlc/adapter-binding.yaml` — `type: github` and `type: gitlab` both supported, with `spec.config` (url/token) honored for self-hosted; `options.sourceControl` injection still wins
- [ ] #2 When no SourceControl AdapterBinding is present, behavior defaults to GitHub exactly as today (no regression for existing adopters)
- [ ] #3 Local-only mode (no remote, or explicit local) gracefully skips push/create-pr instead of timing out against a remote API; coordinated with AISDLC-527's git-remote guard
- [ ] #4 The existing GitLab adapter is constructable from AdapterBinding config end-to-end for the pipeline's source-control usage; any remaining gaps are documented in PR notes, not silently shipped
- [ ] #5 Docs document SourceControl adapter selection (github/gitlab/local) with the self-hosted GitLab `adapter-binding.yaml` example; hermetic tests cover github default, gitlab resolution, and local-only skip; pnpm build + pnpm test + lint + format:check pass
<!-- AC:END -->
