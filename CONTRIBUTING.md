# Contributing to AI-SDLC Framework

Thank you for your interest in contributing to the AI-SDLC Framework specification. This document explains how to participate.

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
