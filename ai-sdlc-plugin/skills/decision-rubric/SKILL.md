---
name: decision-rubric
description: Apply a rigorous decision rubric when asking the user for a non-trivial design, architectural, or policy choice via AskUserQuestion. Replaces shallow "do you agree with the author's recommendation?" prompts with a full problem statement → industry research → 3-4 options with tradeoffs → recommendation + counter-argument → AskUserQuestion. Invoke whenever the user is being asked to decide an RFC Open Question, pick a library or pattern, set a default, choose a deprecation policy, or make any choice they would later regret if the framing were shallow. Do NOT use for trivial preferences (naming, formatting, which file to edit first) — those get a plain AskUserQuestion.
---

# Decision rubric — how to ask the operator a non-trivial design question

Shallow question-asking is worse than not asking at all. The failure mode this rubric exists to prevent, as the operator who prompted it put it:

> "I don't like this new method of resolving the questions. It doesn't go through the thinking rubric we have been doing with the questions that produces meaningful answers — it just skims over the questions and recommends the authors recommendations."

That failure shape: read the OQ → restate the author's lean → ask "agree?". The operator picks "yes" because there's nothing else to compare against, and the decision they thought they were making was actually the author's decision rubber-stamped. Six months later a real edge case surfaces and the resolution is too thin to interpret.

This skill exists so future-you doesn't do that.

## When to invoke this rubric

**YES — apply the rubric** when the user is choosing:

- An RFC Open Question resolution
- A default value that ships to adopters (timeouts, retry counts, grace periods, batch sizes, severity thresholds)
- A library, framework, or major dependency
- An architectural pattern (single-tenant vs multi-tenant, push vs pull, sync vs async, monolith vs split)
- A deprecation / migration / lifecycle policy
- A schema shape that's hard to change later (DB columns, public API contracts, file formats, URI structures)
- A trade-off between two real engineering concerns (performance vs simplicity, strict vs lazy, eager vs lazy)
- Anything where the user's likely answer depends on context they have and you don't

**NO — skip the rubric** when:

- The choice is a personal preference (file naming, commit message style, which color emoji)
- The choice is fully reversible in <5 minutes (which directory, what to call a variable)
- One option is dominant on every axis (there's no real trade-off)
- The user has already stated a preference in this session or in memory
- You're asking for missing facts ("what's the issue number?", "which branch?") — those get a plain AskUserQuestion or just-ask-in-text

## The five-part rubric

Every part is non-optional when the rubric applies. Skipping any one is the failure mode.

### 1. Problem statement

One short paragraph. Restate the decision in your own words. Name the axes of trade-off explicitly. If the decision has multiple sub-questions, surface that — don't lump them.

The point of this part is **forcing yourself to actually understand the question** before recommending an answer. If you can't write the problem statement in two sentences, you don't understand the question well enough to recommend anything.

### 2. Industry research

A short, evidence-loaded paragraph or table. What do comparable systems do? Cite specific products, conventions, or published patterns. Examples:

- "Pinecone / Weaviate refuse cross-vectorizer comparison; LangChain in-process stores re-embed silently."
- "Kubernetes API deprecation policy: 12 months GA, 9 months beta. Stripe: 1 year for breaking changes. OpenAI: 12-15 months on embeddings."
- "Tailwind / Material / Stripe / Vercel all use the design-tokens flat pattern; no major framework permits nested variant declarations."

Don't fabricate. If you don't know, say so and constrain the question. Citing a real existing pattern is what makes the rubric real research vs. a vibes-based recommendation.

### 3. Three to four options with tradeoffs

A table is usually the right shape. Columns: option label, pros, cons, verdict (or a relevant axis like "cost", "complexity", "rigor").

Each option must be **genuinely different** — not three flavors of the same answer with cosmetic variation. If options 2 and 3 are essentially the same, the rubric is hiding the real decision.

At least one option should be the author's lean (or whatever the "obvious" default is). At least one should be a meaningful alternative that has a real reason to be considered. Including a "reject this on examination" option is fine and often clarifying.

### 4. Recommendation + counter-argument

State the recommendation. Then immediately write the strongest counter-argument you can construct against it, and respond to that counter-argument.

The counter-argument is **load-bearing**. Without it, the recommendation is unfalsifiable — the user has no way to know which assumption is doing the work. The counter-argument exposes the assumption.

A weak counter-argument is the same failure mode as no counter-argument. Steel-man the opposing view: "the strongest case against this is..." not "someone might say..."

Then explicitly state why the recommendation wins despite the counter-argument. "Selected over [option N] because [reason that survives the counter-argument]."

### 5. AskUserQuestion

Exactly 3-4 options. The recommended option first, with `(Recommended)` suffix in the label.

Each option's `description` field is 1-3 sentences that capture the trade-off concretely. **Not** "this is the safer choice" — write what the choice actually costs or buys in terms of the trade-off axes named in part 1.

Make the options mutually exclusive. If two options could both be true, you haven't surfaced the real choice.

The `header` field gets a 1-3 word chip label (e.g., "Storage backend", "Cross-provider", "Deprecation"). Short enough to read at a glance.

## Worked example

A real instance from the AI-SDLC framework's own RFC corpus, RFC-0019 OQ-1 (vector storage backend):

> ### OQ-1: Vector storage backend — JSONL vs sqlite?
>
> **Problem statement.** Vectors need persistence across pipeline runs. Read pattern = textHash lookups (cache hits + read-during-scan). Write pattern = append-on-embed. Scale: v1 bootstrap corpus is small (~50-200 RFCs ≈ low thousands of vectors); adopter corpora could reach 100K+. Operational concerns: backup, restore, GC, migration, debugging.
>
> **Industry research.**
> - LangChain / LlamaIndex default to in-process stores (FAISS, Chroma) — runtime-only, no operator-debuggable substrate
> - OpenAI cookbook: pickle for tiny corpora, FAISS or pgvector for production
> - Existing AI-SDLC substrate: `_dor/`, `_deps/`, `_subscription-ledger/`, `_captures/`, `_decisions/` ALL use JSONL append-only — strong consistency principle
> - Rough perf: 1536-dim cosine over 10K vectors ≈ 50ms in JS, 100K ≈ 500ms, 1M ≈ 5s
>
> **Options.**
>
> | Option | Pros | Cons | Verdict |
> |---|---|---|---|
> | A. JSONL append-only | Matches every substrate; jq/grep debugging; crash-safe; mtime-GC | Linear scan (~50ms at 10K); ~3x disk overhead | Author's lean |
> | B. sqlite | Indexed sub-ms lookup; ATOMIC migrations; binary vector storage | Breaks jq/grep convention; +1 native dep; no git-diff history | Faster but forks substrate |
> | C. Parquet | Compact columnar; fast bulk reads | Append is expensive (write-once format) | Wrong shape |
> | D. Plugin-only, no default | Maximum flexibility | Bootstrap broken; blocks downstream consumers | Punts the problem |
>
> **Recommendation: A (JSONL) for v1, with `EmbeddingStorageBackend` interface as documented escape hatch.** Add a scale-escalation heuristic in config docs: "When count per (provider, modelVersion) exceeds ~100K entries OR p95 read latency exceeds 250ms, swap to a sqlite backend." Makes the JSONL→indexed transition operator-visible and corpus-driven rather than tribal knowledge.
>
> **Counter-argument.** "Just use sqlite from day one — file is still portable, indexes solve perf, and the 'jq debugging' argument is overweighted because vector data isn't human-readable anyway." Rebuttal: the JSONL value isn't reading 1536-float vectors by eye — it's `jq '.embeddingProvider' | sort | uniq -c` to audit provenance, `grep <textHash>` to confirm a write. Those ops are the substrate-debugging story consistency enables. sqlite forces sqlite3-CLI knowledge for the same ops.
>
> **Selected over D** because bootstrap experience must work end-to-end. **Selected over B** because substrate-consistency outweighs indexed-lookup at v1 scale, and the escape hatch is already in the spec.

Then the AskUserQuestion with four options, recommended first, descriptions naming the concrete trade-offs.

## Specific anti-patterns to avoid

**Asking "do you agree with the recommendation?"** — that's not a decision question, it's a sanity check. If you only have one real option, just do the thing; don't fake-consult.

**Putting the recommendation only in the question text, not as one of the answer options.** The user has to be able to pick the recommendation by clicking, not by typing free-text.

**Burying the trade-off in the description with hedge words.** "May be slower" / "could be harder" / "potentially less rigorous" — write the actual cost. "~500ms read latency at 100K entries." "Adds 5MB to install footprint." Numbers and concrete consequences.

**Making the options non-mutually-exclusive.** If "use sqlite" and "use sqlite with indexes" are both options, you don't have a decision — you have two ways of describing the same answer. Collapse.

**Skipping the counter-argument because the recommendation feels obvious.** If the recommendation is genuinely obvious, you don't need the rubric — just do the thing. If you're using the rubric, the counter-argument is non-optional.

**Letting the author's lean (or the prior shallow resolution) anchor every option.** Read the question fresh. The author's lean is one option, not the frame for the others.

**Batch-resolving multiple questions in one AskUserQuestion** (e.g., "approve resolutions to OQ-1 through OQ-7?"). Each non-trivial OQ gets its own rubric and its own question. Batch-mode is the failure mode this skill was created to prevent.

## Output shape

Each rubric instance lands in the user-facing message as roughly this structure:

```
### <Question identifier>: <one-line restatement>

**Problem statement.** <paragraph>

**Industry research.** <bullets or table>

**Options.** <table with 3-4 rows>

**Recommendation: <Option label>.** <reasoning>

**Counter-argument.** "<steel-manned objection>" <rebuttal>

**Selected over <other options> because <load-bearing reason>.**
```

Then the AskUserQuestion tool call with 3-4 options matching the rubric.

Keep the prose tight — this isn't a research paper. The five parts can fit in 200-400 words of body before the tool call. What matters is that each part is *load-bearing* — if you could delete a part without changing the recommendation's justification, the part wasn't doing work.

## Compose with other patterns

- After the user answers, **write the resolution to the relevant file with full rationale** (problem statement summary + recommendation + counter-argument compressed to 3-5 sentences). Don't just record "answer: A". The shallow-resolution failure mode is what happens when the file only records the answer, not the reasoning.
- For multi-question walkthroughs (RFC with N OQs), apply the rubric N times. Do not batch.
- Catalog-routed events: if the decision has runtime consequences and the Decision Catalog is enabled (`AI_SDLC_DECISION_CATALOG`, default-ON), frame them as Decision-Catalog events (RFC-0035 G0) so future operators can audit how the resolution was applied — `node pipeline-cli/bin/cli-decisions.mjs add --summary "..." --scope <area> --option "<id>:<description>"`.
