# AI-SDLC Documentation

User-facing documentation for the AI-SDLC Framework.

> **Source of truth.** This directory (`ai-sdlc/docs/`) is the canonical source for all user-facing documentation. The published site at `ai-sdlc-io/content/docs/` is generated from these `.md` files via `pnpm docs:sync` (`scripts/docs-sync.mjs`). **Always edit here, never directly in `ai-sdlc-io`.**
>
> CI catches drift via `pnpm docs:check` (`scripts/check-docs-sync.mjs`). See [`backlog/decisions/AISDLC-68-documentation-consolidation.md`](../backlog/decisions/AISDLC-68-documentation-consolidation.md) for the architecture decision.

## Sections

| Section | Description |
|---|---|
| [Getting Started](getting-started/) | Installation, CLI quick start, first pipeline |
| [Tutorials](tutorials/) | Step-by-step walkthroughs (5 tutorials) |
| [API Reference](api-reference/) | Complete SDK and orchestrator reference |
| [Examples](examples/) | Runnable TypeScript and YAML examples |
| [Architecture](architecture.md) | Package structure, data flow, design decisions |
| [Troubleshooting](troubleshooting.md) | FAQ, common errors, environment variables |

## Quick Links

- **New to AI-SDLC?** Start with [Getting Started](getting-started/) for installation and CLI quick start.
- **Configuring agent runners?** See the [Runners Reference](api-reference/runners.md) for all supported agents.
- **Building with the SDK?** See the [API Reference](api-reference/) for types, functions, and examples.
- **Learning the concepts?** Read the [Primer](../spec/primer.md) for a conceptual introduction.
- **Implementing a spec?** The [Specification](../spec/spec.md) contains the full normative requirements.

## For Spec Contributors

The normative specification lives in [`spec/`](../spec/). These docs are informative guides aimed at implementors and end users.

## License

Apache-2.0
