---
name: context-capture
description: Capture facts from a conversation, document or finding as inferred knowledge entries with a confidence band and a re-verify note; a correction supersedes the earlier entry.
argument-hint: '<source: path | url | "text"> [--scope internal|protected]'
allowed-tools: Bash, Read, Write
model: sonnet
rung: 4
---

Capture knowledge into the context engine (RFC-0053). Adapted from the capture-knowledge mechanics of the data-room kit. Capture writes entries, never documents.

## Rules (hard)

1. **Authority is always `inferred`.** Never write `specialist` or `canonical`; promotion belongs to the promotion verifier (code) or a human.
2. **Every entry carries a `reverify:` note** saying how a later reader can re-check it (a file path, a test id, a decision id, or a command to re-run).
3. **Every entry carries a confidence band** and a numeric `confidence` inside it:
   | Band | Range | Meaning |
   |---|---|---|
   | candidate | below 0.7 | weak signal, surfaced as a question |
   | working | 0.7 to 0.85 | agent inference, usable |
   Confidence is capped at 0.85 for agent-written entries.
4. **Every entry carries a source citation and an observed date**, and a decay class (volatile 30 days, seasonal 180 days, durable 2 years, evergreen).
5. **Supersede, never delete.** When the user or the source corrects an earlier entry, write a new `inferred` entry with `supersedes: <old-id>` and mark the old entry `superseded_by: <new-id>`. Do not remove or overwrite the old entry body.
6. **Scope routes the root.** `scope: protected` entries go to the gitignored protected root and never into a tracked file or a PR body.
7. **Re-observation** of an existing fact moves confidence 30 percent toward the new value and never changes authority.

## Steps

1. Read the source named in `$ARGUMENTS`.
2. Search for an existing entry on the same fact before writing (`cli-context query` when available, otherwise grep the knowledge root).
3. For each new fact, write an entry with the full schema (id, value, confidence, band, `authority: inferred`, scope, source, observed, decay, relations, `reverify:`).
4. For each correction, follow rule 5 and report the superseded id.
5. Print a table: id, band, confidence, supersedes, reverify.

## Important

- Running code outranks every written entry; when the source conflicts with the code, record the code's behavior and cite it.
- Never write under a data-room root; capture writes entries only.
