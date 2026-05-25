# Adopter Translator Examples

Reference scaffolds for the **bring-your-own translator** pattern documented in [`docs/concepts/adopter-translators.md`](../../concepts/adopter-translators.md) (RFC-0036 Phase 10 / OQ-6).

The framework's spec-kit bridge (`cli-import-spec`) ships with one first-party upstream adapter — [GitHub Spec Kit](https://github.com/github/spec-kit). Every other upstream (Linear, Notion, Jira, plain markdown, etc.) feeds the bridge via a translator the adopter writes themselves. The translator's only job is to emit a spec-kit-compatible `tasks.md` at a path `cli-import-spec --from <path>` can consume.

These examples are **documentation, not framework code**. Copy the file you want into your own repo at `.ai-sdlc/translators/<adopter>.ts`, install whatever upstream-specific dependencies you need, and adapt the mapping logic to your conventions.

## Files

| File | Purpose |
|---|---|
| [`example-adopter.ts`](example-adopter.ts) | A typed scaffold with `// TODO:` markers. Use as a starting point for a translator targeting any upstream. |
| [`linear-translator.ts`](linear-translator.ts) | A minimal worked example: Linear issues → `tasks.md`. Demonstrates upstream fetching, AC checklist extraction, and idempotent output writing. |

## Running an example

The examples are dependency-free TypeScript by design — they document the shape of a translator, not a runtime contract. To run them as-is:

```bash
npx tsx docs/examples/translators/example-adopter.ts --help
npx tsx docs/examples/translators/linear-translator.ts --help
```

The scaffold prints its usage and exits. The Linear example needs a `LINEAR_API_KEY` env var and a `--project <id>` argument; without those it prints usage and exits without writing.

## Canonical format the translator must produce

The bridge consumes a spec-kit-compatible `tasks.md` (see [`docs/concepts/adopter-translators.md` §2](../../concepts/adopter-translators.md#2-the-canonical-task-import-format)). The recommended layout for new translators is `v0.8-headings`:

```markdown
# <feature title> — Tasks

## Tasks

### T-001 — <task title>

<optional multi-line body>

- AC: <binary-testable acceptance criterion>
- AC: <another AC>

### T-002 — <next task title>

...
```

The reference parser lives at [`pipeline-cli/src/import-spec/parser.ts`](../../../pipeline-cli/src/import-spec/parser.ts) — that's the contract the translator output must satisfy.

## Type checking

Both scaffolds are intentionally framework-import-free so they compile in any TypeScript-strict project. To type-check them in this repo:

```bash
cd docs/examples
npx tsc --noEmit
```

## See also

- [`docs/concepts/adopter-translators.md`](../../concepts/adopter-translators.md) — full BYO translator pattern docs
- [`docs/tutorials/10-spec-kit-bridge.md`](../../tutorials/10-spec-kit-bridge.md) — end-to-end spec-kit bridge walkthrough
- [RFC-0036 §14 OQ-6](../../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md) — normative resolution for the BYO pattern
- [RFC-0035 Decision Catalog](../../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) — how adopter demand signals promote a BYO translator to first-party
