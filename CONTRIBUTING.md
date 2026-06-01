# Contributing to AI-SDLC Framework

Thank you for your interest in contributing to the AI-SDLC Framework specification. This document explains how to participate.

## Issue-first workflow

**Opening a GitHub Issue before a Pull Request dramatically reduces overhead for everyone involved.**

### Why

When an external contributor submits a PR without a linked issue, a maintainer must manually:

1. Understand the motivation (is this the right approach? does it duplicate in-flight work?)
2. Coordinate rebases if main moves during review
3. Handle attestation ceremony (re-sign after each rebase)
4. Work around GitHub's fork-token read-only limitations

Contrast this with the issue-first path:

1. Contributor opens an issue describing the problem or proposal
2. Maintainer reviews the issue, confirms it fits the roadmap
3. Maintainer (or the contributor once invited to the repo) runs `/ai-sdlc execute <issue-number>`
4. The automated pipeline implements, tests, reviews, and opens a signed PR in 5-20 minutes

### The workflow

```
1. Open a GitHub Issue:
   https://github.com/ai-sdlc/ai-sdlc/issues/new

2. Describe the problem or proposal clearly.
   - Bug: what is the current behavior? what is expected?
   - Feature: what is the use case? what does the ideal API look like?

3. A maintainer will triage and — if accepted — implement via the pipeline,
   or invite you to implement it. Either way, the issue is the anchor.
```

### The CI check

Every PR automatically receives an `ai-sdlc/issue-link` status check that scans the PR title and body for a linked-issue reference. Accepted forms:

- GitHub-issue keywords: `Closes #N`, `Fixes #N`, `Resolves #N`, or cross-repo `org/repo#N`
- Backlog-task references (for backlog-track PRs): `References AISDLC-N`, `Closes AISDLC-N`, or hierarchical `AISDLC-N.M`

- **Success** — a reference was found, or the PR carries the `ci:no-issue-required` label.
- **Failure** — no reference found. The check is informational; it will NOT block your PR from merging unless a maintainer has made it required in branch protection settings.

The bypass label `ci:no-issue-required` is intended for:

- `release-please` rolling PRs
- `dependabot` version bumps
- Self-evident maintainer chores (typos, minor doc tweaks)

### What if I already opened a PR without an issue?

That's okay — add `Closes #N` (GitHub-issue path) or `References AISDLC-N` (backlog-task path) to your PR body and re-sync your PR. The check will re-run on the next push.

## Types of Contributions

### Spec Edits (Normative)

Changes to normative documents (`spec.md`, `adapters.md`, `policy.md`, `autonomy.md`, `agents.md`, `metrics.md`) affect the formal specification. These changes:

- **MUST** go through the [RFC process](spec/rfcs/README.md) if they add, remove, or modify normative requirements
- **MUST** receive approval from at least 2 maintainers
- **MUST** observe a 7-day comment period before merging
- **SHOULD** include corresponding JSON Schema updates where applicable
- **SHOULD** include updates to the glossary for new terms

### Schema Updates

Changes to JSON Schema files in `spec/schemas/`:

- **MUST** remain valid JSON Schema draft 2020-12
- **MUST** match the normative text in spec documents
- **MUST** preserve backward compatibility within a spec version (no removing required fields)
- **SHOULD** include example resource documents that validate against the updated schema

### RFCs (Enhancement Proposals)

Significant changes to the specification require a formal RFC:

- Copy `spec/rfcs/RFC-0001-template.md` to `spec/rfcs/RFC-NNNN-title.md`
- Fill in all sections
- Submit as a pull request for discussion
- See the [RFC process](spec/rfcs/README.md) for the full lifecycle

### Editorial Changes

Typo fixes, formatting improvements, and clarifications that do not change normative meaning:

- May be submitted directly as a pull request
- Require 1 maintainer approval
- No comment period required

### Informative Content

Changes to informative documents (`primer.md`, `glossary.md`):

- Require 1 maintainer approval
- No RFC required unless the change introduces new concepts

### Reference Implementation

Changes to the reference implementation (`reference/`):

- **MUST** maintain consistency with the normative specification
- **MUST** include or update tests for new functionality
- **SHOULD** update TypeScript types when schemas change
- Require 1 maintainer approval

### Conformance Tests

Changes to the conformance test suite (`conformance/`):

- **MUST** use language-agnostic YAML fixtures
- **MUST** follow the `valid-*` / `invalid-*` naming convention
- **SHOULD** cover edge cases defined in normative text
- Require 1 maintainer approval

### SDKs

Changes to SDK packages (`sdk-typescript/`, `sdk-python/`, `sdk-go/`):

- **MUST** maintain type-level compatibility with JSON schemas
- **SHOULD** follow idiomatic patterns for the target language
- Require 1 maintainer approval from a sig-sdk member

### Community Adapters

New or updated adapters in `contrib/adapters/`:

- **MUST** include a valid `metadata.yaml`
- **MUST** implement at least one interface contract from `spec/adapters.md`
- **SHOULD** include usage examples in the adapter README
- Require 1 maintainer approval

## Style Guide

### Normative Language (RFC 2119)

This specification uses [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) keywords:

- **MUST** / **MUST NOT** — Absolute requirement or prohibition
- **SHOULD** / **SHOULD NOT** — Recommended, with valid reasons to deviate
- **MAY** — Optional behavior

These keywords:
- **MUST** be capitalized when used with their normative meaning
- **MUST** only appear in normative documents (not in `primer.md` or `glossary.md`)
- **MUST NOT** be used in headings

### Formatting

- Use [GitHub-Flavored Markdown](https://github.github.com/gfm/)
- Wrap lines at 80 characters in normative documents where practical
- Use fenced code blocks with language identifiers (```yaml, ```json)
- Use HTML comments for PRD traceability: `<!-- Source: PRD Section 8.1 -->`
- Cross-reference glossary terms on first use: `[reconciliation loop](glossary.md#reconciliation-loop)`
- Cross-reference between spec documents with relative links and anchors: `[Pipeline](spec.md#51-pipeline)`

### Schema Conventions

- JSON Schema draft 2020-12
- `$id` base URL: `https://ai-sdlc.io/schemas/v1alpha1/`
- Resource names: DNS-label format `^[a-z][a-z0-9-]*$`, max 253 characters
- Enum values: lowercase-kebab-case
- Timestamps: ISO 8601 `date-time` format
- Durations: pattern `^\d+[smhdw]$` or ISO 8601
- Shared types via `$ref` to `common.schema.json#/$defs/...`

## Review Process

1. **Author** submits a pull request with a clear description of the change
2. **Reviewers** provide feedback within 7 days (normative changes) or 3 days (editorial)
3. **Maintainers** approve (2 required for normative, 1 for editorial)
4. **Comment period** runs for 7 days after the last substantive change (normative only)
5. **Merge** after approvals and comment period are complete

## Development Setup

This is a pnpm monorepo. To get started:

```bash
# Prerequisites: Node.js >= 20, pnpm >= 9

# Install all dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Validate JSON schemas
pnpm validate-schemas
```

### Should co-developers use the published `@ai-sdlc/orchestrator` or a local checkout?

**Use a local checkout when contributing changes to AI-SDLC itself.** Run
`pnpm --filter @ai-sdlc/orchestrator build` and link the dist binary
(`pnpm --filter @ai-sdlc/orchestrator exec node dist/cli/index.js …`) so
the version you exercise is the one your branch ships. The published npm
package is a snapshot — if you `npm i -g @ai-sdlc/orchestrator` while
hacking on a feature branch, the global binary will mask your edits and
you will silently test the wrong code.

**Use the published package when integrating AI-SDLC into a downstream
project.** Run `npm i -g @ai-sdlc/orchestrator@latest` (or pin a specific
version in your project's tooling) and let `ai-sdlc init` write a pinned
`@ai-sdlc/mcp-advisor@<version>` into your `.mcp.json`. Reproducible
deploys come from pinned dependencies, not floating tags.

`ai-sdlc --version` prints a 3-line block (CLI / orchestrator / plugin
versions) so you can spot drift between a global install and a
co-located plugin checkout. If the lines disagree, the CLI emits a
`WARN  versions out of sync` line pointing at the upgrade command.

## Shell Script Safety — Guarding `rm` with Variable Paths

When writing shell scripts (`.sh` files or shell blocks embedded in command `.md` files), any
`rm -rf` or `rm -f` that uses a variable in the path **MUST** be preceded by a non-empty guard
on the same variable immediately before the `rm` line. The variable being empty would cause the
path to expand to a root-relative location (e.g. `rm -rf "/$x"`) and silently delete unintended
directories. Claude Code's built-in safety prompt also blocks unguarded variable `rm` operations
in unattended mode, stalling autonomous runs.

**Required pattern:**

```bash
# Guard immediately before the rm (within 5 lines, same shell block):
[ -n "$MY_VAR" ] || { echo "refusing rm: MY_VAR empty" >&2; exit 1; }
rm -rf "$MY_VAR/$subdirectory"
```

**Rules:**

1. The guard **MUST** appear within 5 lines above the `rm` invocation in the same shell block.
2. Where the target is a worktree under `.worktrees/`, **prefer `git worktree remove --force`**
   over raw `rm -rf` — it cleanly unregisters the worktree from git's list and removes its
   directory atomically. Use guarded `rm -rf` only for non-worktree temp dirs (e.g. mktemp
   outputs).
3. Fixed literal paths (no variable expansion) do not need a guard — e.g.
   `rm -f .worktrees/.active-task` is safe because it cannot expand to a root-relative path.

**Regression gate:** `scripts/check-rm-guard.test.mjs` (run via `node --test scripts/check-rm-guard.test.mjs`)
scans `ai-sdlc-plugin/` and `scripts/` for unguarded variable `rm` patterns. Adding a new
`rm -rf "$VAR/..."` without a guard within 5 lines will fail the test and block the PR.

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) enforced by [commitlint](https://commitlint.js.org/). Every commit message must follow this format:

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Purpose |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, missing semicolons, etc. |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `chore` | Build process, tooling, dependencies |
| `ci` | CI configuration |
| `revert` | Reverts a previous commit |

### Scopes

Scopes are optional but encouraged. Allowed scopes: `reference`, `conformance`, `sdk`, `sdk-typescript`, `orchestrator`, `mcp-advisor`, `sdk-python`, `sdk-go`, `dashboard`, `dogfood`, `deps`, `ci`, `spec`, `docs`.

### Examples

```bash
feat(reference): add pipeline validation endpoint
fix(sdk-typescript): handle null stage metadata
chore(deps): bump eslint to v9
docs: update contributing guide
```

### Breaking Changes

Add `!` after the type/scope, or include a `BREAKING CHANGE:` footer:

```bash
feat(sdk)!: rename Pipeline to Workflow
# or
feat(sdk): rename Pipeline to Workflow

BREAKING CHANGE: Pipeline class has been renamed to Workflow.
```

## Versioning & Releases

This project uses [release-please](https://github.com/googleapis/release-please) to automate versioning and changelogs. **You do not need to manually bump versions or write changelog entries.**

How it works:

1. Write commits using conventional commit format (enforced by the commit-msg hook)
2. When commits land on `main`, release-please automatically creates or updates a **Release PR** that accumulates version bumps and changelog entries
3. When a maintainer merges the Release PR, packages are published to npm/PyPI automatically

Only `feat`, `fix`, `perf`, and `revert` commits appear in changelogs. Other types (`chore`, `refactor`, `test`, `ci`, `docs`) are processed for version bumps but hidden from changelogs.

### Working with specific packages

```bash
# Build only the reference implementation
pnpm --filter @ai-sdlc/reference build

# Run tests for the conformance suite
pnpm --filter @ai-sdlc/conformance test

# Type-check the SDK
pnpm --filter @ai-sdlc/sdk lint
```

### Validating schemas manually

```bash
# Validate a resource against its schema
npx ajv-cli validate -s spec/schemas/pipeline.schema.json -r "spec/schemas/common.schema.json" -d example.json
```

To check markdown links:

```bash
npx markdown-link-check spec/spec.md
```

## Code of Conduct

All contributors must follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Questions?

Open a [GitHub Discussion](../../discussions) for questions about contributing.
