---
id: RFC-0037
title: Adopter Project Context Inheritance
status: Draft
lifecycle: Draft
author: Alexander Kline
created: 2026-05-19
updated: 2026-05-19
targetSpecVersion: v1alpha1
requires: [RFC-0010, RFC-0012, RFC-0036]
requiresDocs: []
---

# RFC-0037: Adopter Project Context Inheritance

**Status:** Draft
**Lifecycle:** Draft
**Author:** Alexander Kline (Product owner contribution)
**Created:** 2026-05-19
**Updated:** 2026-05-19
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — Dominique Legault
- [ ] Product owner — Alexander Kline

## 1. Summary

Adopter projects accumulate domain-specific conventions (architectural primitives, doc taxonomies, failure-mode lexicons, investigation trails, linguistic norms) that the framework's dispatched developer + reviewer agents should inherit at task dispatch time. The framework currently has no clean mechanism for this. Adopters resort to either (a) inlining context in every ticket body (manual, doesn't scale), (b) forking the plugin (defeats the framework's value proposition), or (c) writing project-local `.claude/agents/*.md` overrides that may or may not be respected by the plugin's `Agent({subagent_type: "developer"})` lookup.

This RFC proposes a well-known adopter-context override path (e.g., `.ai-sdlc/project-context.md`) that the plugin auto-prepends to the developer and reviewer agent system prompts when dispatching `/ai-sdlc execute`. The framework defines the path + load semantics; the adopter decides the content.

## 2. Motivation

### The adopter-pain pattern (production evidence)

In production usage of `/ai-sdlc execute` on an adopter project carrying ~6 months of accumulated work, two recent P0 incidents both required ~90 minutes of root-cause investigation before reaching the relevant adopter-internal architectural specs that named the failure class explicitly. The dispatched developer agent had no path to those specs — they exist in the adopter's `memory/architecture/` directory (an adopter convention, not a framework convention), and the agent only finds them by accident if it greps for the right terms.

### Why this isn't a one-adopter problem

Every adopter project doing real work over time develops conventions specific to its domain:

- A fintech adopter accumulates consistency-model specs that transaction-touching code must respect
- A games adopter accumulates save-game compatibility rules that all serialization-touching code must respect
- A healthcare adopter accumulates PHI-handling specs that all data-touching code must respect
- A research adopter accumulates methodology constraints that all analysis-touching code must respect
- An open-source library adopter accumulates API stability rules

In each case, the dispatched developer agent is **structurally unaware** of conventions that are load-bearing for the adopter's domain. The agent doesn't know what it doesn't know.

### Why ticket-body inlining doesn't scale

Some adopters paper over the gap by inlining context in every TASK ticket body. This works for one ticket but:

- Multiplies content-management overhead by N tickets
- Drifts as conventions evolve (every ticket needs re-syncing)
- Pollutes the ticket's own scope with framework-context
- Doesn't help cross-project conventions like architectural patterns that span the codebase

The right level for adopter-project context is **the adopter project**, not the ticket. The framework should provide the load mechanism; the adopter writes once.

## 3. Goals and Non-Goals

### Goals

- Standard well-known path for adopter-project context that the plugin recognizes
- Auto-prepend to developer + reviewer agent system prompts at dispatch time
- Optional — works fine if absent (no breaking change for existing adopters)
- Format-agnostic — the framework reads, the adopter authors freeform markdown
- Length cap to prevent context bloat (~500 lines? configurable cap with warning above threshold)

### Non-Goals

- The framework prescribing WHAT adopter-context should contain
- Multi-file context aggregation (single canonical file; adopter can reference others from it)
- Replacing `.claude/agents/*.md` project-local overrides — this layer is additive
- Replacing per-ticket context — high-leverage tickets may still inline ticket-specific context

## 4. Proposed Mechanism

### 4.1 Well-known path

Plugin recognizes `<repo-root>/.ai-sdlc/project-context.md`. If present, its contents are prepended to the system prompt of every plugin-dispatched agent (developer, code-reviewer, test-reviewer, security-reviewer, and any future adopter-defined reviewers per RFC-0038).

Rationale for `.ai-sdlc/` path:
- Mirrors existing `.ai-sdlc/pipeline.yaml` and `.ai-sdlc/agent-role.yaml` adopter-configuration files
- Distinguishable from `.claude/agents/` which is Claude-Code-general agent definitions
- Discoverable; co-located with other adopter governance configuration

### 4.2 Length cap + warning

Default cap: 500 lines. Above cap: log warning during pipeline initialization. Above hard cap (configurable, default 2000 lines): refuse to load and surface error.

Rationale: protects adopters from context-bloat anti-patterns. The point is to teach the agent project conventions, not to inline the entire architecture spec.

### 4.3 Composition with existing layers

Loading order at agent dispatch:
1. Framework default agent system prompt (plugin-provided)
2. Adopter `.ai-sdlc/project-context.md` (this RFC's contribution)
3. Project-local `.claude/agents/<name>.md` override (if present, Claude Code convention)
4. Task ticket body (per-dispatch context)

Layers (2) and (3) are independent — adopters can use either, both, or neither. The proposed file is for cross-cutting context that should apply to ALL agents; `.claude/agents/<name>.md` is for per-agent customization.

## 5. Schema Changes

None required. The file path is convention, not schema. A future RFC could promote this to a schema field in `pipeline.yaml`'s `spec.adopter` block if more configuration becomes necessary.

## 6. Backward Compatibility

Fully backward-compatible. Existing adopters who don't ship `.ai-sdlc/project-context.md` see no behavior change.

## 7. Composition with Other RFCs

- **RFC-0010 (parallel execution / worktree pooling)**: the context file lives in the parent repo, naturally inherited by every worktree
- **RFC-0036 (spec-kit bridge + adopter spec-authoring)**: this RFC's context file is one of the artifacts an adopter authors via the spec-kit funnel
- **RFC-0038 (adopter-defined reviewer extension point)**: adopter-context applies to adopter-defined reviewers too
- **RFC-0011 (definition-of-ready gate)**: DoR clarification questions can reference adopter-context, validating against the project's domain conventions

## 8. Alternatives Considered

### 8.1 Per-agent override via `.claude/agents/<name>.md`

Already works for cases where one agent type needs full custom prompting. Doesn't address cross-cutting context that applies to ALL plugin-dispatched agents.

### 8.2 Per-ticket inlining

Works but doesn't scale (see §2). Manual content management overhead grows linearly with tickets.

### 8.3 Framework-level "domain pack" registry

Heavier proposal — framework ships pre-curated domain packs (fintech / healthcare / games / etc.) that adopters can register. Too prescriptive at this stage. RFC-0037 stays freeform.

## 9. Open Questions

1. **Cap value**: 500 lines default reasonable, or should it be 1000? Or token-based instead of line-based?
2. **Path naming**: `.ai-sdlc/project-context.md` vs `.ai-sdlc/CONTEXT.md` vs `.ai-sdlc/adopter-context.md`. Bikeshed.
3. **Per-agent vs cross-agent**: should the file have sections that target specific agent types (e.g., a `## For reviewers` section that ONLY reviewers see)? Or is the freeform "prepend to all" semantic correct?
4. **Inheritance from parent file**: should the file support `@include` directives for composing from multiple sources? Or is single-file simplest?

## 10. References

- Existing plugin agent definitions: `ai-sdlc-plugin/agents/developer.md`, `code-reviewer.md`, etc.
- Existing adopter configuration: `.ai-sdlc/pipeline.yaml`, `.ai-sdlc/agent-role.yaml`
- Composing RFCs: RFC-0010, RFC-0011, RFC-0036
