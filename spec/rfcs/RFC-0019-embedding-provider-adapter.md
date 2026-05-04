---
id: RFC-0019
title: Embedding Provider Adapter Framework
status: Draft
lifecycle: Draft
author: dominique@reliablegenius.io
created: 2026-05-03
updated: 2026-05-03
targetSpecVersion: v1alpha1
requires:
  - RFC-0010
requiresDocs: []
---

# RFC-0019: Embedding Provider Adapter Framework

**Document type:** Normative (draft)
**Status:** Draft (initial seed; structure may shift; open questions in §15)
**Lifecycle:** Draft
**Author:** dominique@reliablegenius.io (with Claude assist)
**Created:** 2026-05-03
**Updated:** 2026-05-03
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — dominique@reliablegenius.io (pending)
- [x] Product owner — Alexander Kline (2026-05-04)
- [ ] Operator owner — dominique@reliablegenius.io (pending)

## Revision History

| Version | Date       | Author    | Notes                                                                                                                                |
| ------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| v1      | 2026-05-03 | dominique | Initial draft per RFC-0009 OQ-6 sub-decision; mirrors RFC-0010 §13 harness adapter pattern + §11 alias deprecation lifecycle.        |

---

## 1. Summary

This RFC introduces a pluggable adapter framework for text→vector embedding providers, mirroring the harness-adapter (RFC-0010 §13) and database-branch-adapter (RFC-0010 §15) patterns already in use across the orchestrator. The reference implementation ships with `openai-text-embedding-3-small` as the default adapter; adopters MAY register custom adapters (other OpenAI models, Cohere, Voyage, locally-hosted ONNX/sentence-transformers, etc.) by implementing the `EmbeddingAdapter` interface and registering with `orchestrator/src/embedding/registry.ts`. Vectors are stored with explicit provider+version provenance so deprecated models can be migrated via a dedicated `cli-embedding-bump` tool without losing audit trail.

## 2. Motivation

### 2.1 RFC-0009 OQ-6 rule #2 requires embedding infrastructure

RFC-0009's Tessellated Design Intent Documents introduces the `Eτ_tessellation_drift` rule (OQ-6 #2) — measuring semantic drift of tessellation shards via embedding distance between successive document revisions. The drift signal is one of several inputs feeding the OQ-6 decision pipeline; without an embedding provider, the rule is undefined and the OQ-6 framework cannot ship. RFC-0019 unblocks RFC-0009 by establishing the embedding substrate.

### 2.2 Embeddings have multiple downstream consumers beyond drift detection

Even if `Eτ_tessellation_drift` were the only consumer today, the framework principle "adapters all the way down" mandates a pluggable pattern. Anticipated near-term consumers:

- **PPA semantic similarity (RFC-0008)** — deduplicate near-identical proposals before ranking; surface "this issue is semantically close to closed issue #N" hints to the operator.
- **DoR clarification deduplication (RFC-0011)** — when the DoR gate posts a clarification comment, embed prior author replies to detect "you've answered this exact clarification before" patterns.
- **Classifier embeddings (RFC-0010 §12)** — the review-classifier already produces structured outputs; an embedding-augmented classifier could route on semantic content beyond filename heuristics.
- **Backlog auto-tagging** — embedding-based clustering of the open backlog surfaces structural duplicates and orphaned themes the operator missed.

Each consumer has different latency/cost/quality tradeoffs. A single hard-coded provider would be wrong for all but one of them; the adapter framework lets each consumer pick its provider while sharing the registry, validation, and storage substrate.

### 2.3 Provider lock-in is a real risk without versioned storage

Embeddings produced by `openai-text-embedding-3-small` (1536 dimensions, model `text-embedding-3-small`, snapshot 2024-01-25) are NOT interchangeable with vectors from `openai-text-embedding-3-large` (3072 dimensions), Cohere `embed-v3.0` (1024 dimensions), or any other provider. An accidental adapter swap silently corrupts every distance computation that reads from storage. The framework MUST treat `(embeddingProvider, embeddingModelVersion)` as part of the vector's identity and refuse to compare vectors across provider/version boundaries without an explicit migration step.

### 2.4 The harness-adapter precedent already validates the pattern

RFC-0010 §13 (HarnessAdapter) and §15 (DatabaseBranchAdapter) ship the same pattern: interface + registry + capability matrix + deprecation lifecycle + default implementation + adopter extension point. RFC-0019 reuses that pattern verbatim — operators who already grok harness adapters get embedding adapters for free.

## 3. Goals and Non-Goals

### 3.1 Goals

- Define the `EmbeddingAdapter` interface with explicit provider+version identity.
- Ship `openai-text-embedding-3-small` as the default adapter, behind feature flag `AI_SDLC_EMBEDDING_PROVIDER` (default OFF in v1).
- Provide a registry pattern parallel to `orchestrator/src/harness/registry.ts`.
- Define a vector storage schema (JSONL by default, sqlite-pluggable by Phase 6+) with embedded provider+version provenance.
- Define a deprecation lifecycle (warning → error → removal) mirroring RFC-0010 §11's model alias pattern.
- Ship `cli-embedding-bump` for operator-driven re-embed when a deprecated adapter must be retired.
- Integrate with `Pipeline.spec.embedding` so adopter pipelines can opt in via configuration without writing code.
- Track embedding token cost in the existing `cost-tracker` infrastructure (RFC-0004).

### 3.2 Non-Goals

- **Vector database integration.** v1 ships a JSONL backend. sqlite, pgvector, Pinecone, Qdrant, Weaviate, etc. are explicit non-goals for v1; the storage backend interface is designed to be replaceable but only one implementation lands in v1.
- **Embedding model training.** This RFC is exclusively about consuming existing pre-trained embedding APIs. Fine-tuning, custom training, and self-hosted-only deployments are out of scope.
- **Cross-provider semantic compatibility.** Vectors from different providers are NOT interchangeable; no attempt is made to "translate" between embedding spaces. Operators who change adapters MUST re-embed their corpus.
- **General-purpose RAG framework.** This RFC ships the embedding substrate; chunking strategies, retrieval-augmented prompting, and RAG application patterns are downstream of this RFC and out of scope here.
- **Multi-modal embeddings.** v1 ships text→vector only. Image, audio, and code-aware embeddings are deferred until a concrete use case in the orchestrator demands them.

## 4. Architecture

The framework has four components:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Pipeline.spec.embedding                      │
│  (operator config: provider, fallback, storage, stale policy)    │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│              orchestrator/src/embedding/registry.ts              │
│        (Map<string, EmbeddingAdapter>, validation, fallback)     │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       EmbeddingAdapter                           │
│   (name, modelId, modelVersion, dimensions, embed, isAvailable, │
│    deprecation lifecycle: deprecatedAt, removedAt, replacement)  │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Vector Storage Backend                        │
│   <artifactsDir>/_embeddings/<provider>-<modelVersion>.jsonl     │
│   Each entry: {vector, embeddingProvider, embeddingModelVersion, │
│                writtenAt, text, textHash}                        │
└──────────────────────────────────────────────────────────────────┘
```

The registry pattern (component 2) is parallel to `orchestrator/src/harness/registry.ts`. The interface (component 3) mirrors `HarnessAdapter` in shape — capabilities + lifecycle + invocation method + availability probe. The storage backend (component 4) is a separate plugin point with its own minimal interface, defaulted to JSONL.

## 5. The EmbeddingAdapter interface

Every embedding adapter MUST implement the following TypeScript interface (declared at `orchestrator/src/embedding/types.ts`):

```typescript
interface EmbeddingAdapter {
  // Canonical adapter alias — the value adopters set in Pipeline.spec.embedding.provider.
  // MUST be unique across the registry. Convention: '<vendor>-<model-family>-<size>'.
  // Examples: 'openai-text-embedding-3-small', 'cohere-embed-v3-multilingual'.
  readonly name: string;

  // Provider-specific model identifier — passed to the upstream API.
  // Example: 'text-embedding-3-small' (the value posted to OpenAI's /embeddings endpoint).
  readonly modelId: string;

  // Snapshot identifier — ISO date for date-pinned snapshots, semver for versioned models.
  // Used as part of the storage key so vectors don't collide across model snapshots.
  // Example: '2024-01-25' for OpenAI's 2024-01-25 text-embedding-3-small snapshot.
  readonly modelVersion: string;

  // Vector length the adapter emits. Validated against storage on first write to detect
  // accidental dimension mismatches early.
  readonly dimensions: number;

  // Embed a single text string. Returns the vector as number[]. Implementations MUST:
  //  - throw on empty input (no silent zero-vector emission)
  //  - throw on input exceeding the provider's per-call token limit
  //  - return a vector of length === this.dimensions (orchestrator validates post-hoc)
  embed(text: string): Promise<number[]>;

  // Optional batch interface. Adapters MAY implement for efficiency; orchestrator
  // calls embed() in a loop when this is undefined.
  // Implementations MUST preserve input order in the returned array.
  embedBatch?(texts: string[]): Promise<number[][]>;

  // Cheap liveness probe. Combines env-var presence (e.g., OPENAI_API_KEY)
  // + lightweight provider health check (optional). Result MAY be cached for the
  // orchestrator's lifetime. Operator restart picks up freshly-installed credentials.
  isAvailable(): Promise<EmbeddingAvailability>;

  // Stable identifier for the credential / account in scope. Used by cost-tracker
  // to attribute spend per credential. MUST be a one-way derivation (e.g., SHA-256
  // of the API key + adapter name) and MUST NOT leak the credential itself.
  // Returns null when the adapter cannot derive an account identity (e.g., self-hosted).
  getAccountId(): Promise<string | null>;

  // Deprecation lifecycle — mirrors RFC-0010 §11 model alias pattern.
  // When set, pipeline-load emits warnings/errors per §9 migration mechanism.
  readonly deprecatedAt?: string;        // ISO date: warning starts, adapter still works
  readonly removedAt?: string;           // ISO date: pipeline-load fails with migration command
  readonly replacementAlias?: string;    // canonical adapter name to migrate to
}

interface EmbeddingAvailability {
  available: boolean;
  reason?: 'env-var-missing' | 'health-check-failed' | 'rate-limited' | 'unknown';
  detail?: string;                       // operator-facing message naming the missing env var or failing probe
}
```

**Why `name` is separate from `modelId`.** The same `modelId` MAY be wrapped by multiple adapters with different default behaviors (e.g., one adapter defaults to truncate-on-overflow, another defaults to error-on-overflow). The `name` is the operator-facing alias; `modelId` is the wire-protocol value. Keeping them distinct preserves the adapter's freedom to evolve without breaking pipeline configs.

**Why `modelVersion` is mandatory.** Without an explicit version, the same logical model can silently change behavior across provider snapshots — OpenAI has done this multiple times with `text-embedding-ada-002`. Pinning the snapshot date in the adapter source makes adapter upgrades a code change (visible in PR review) rather than a silent provider-side rollout.

## 6. Registry and Capability Matrix

### 6.1 Registry

The orchestrator maintains a registry at `orchestrator/src/embedding/registry.ts`:

```typescript
const EMBEDDING_ADAPTERS = new Map<string, EmbeddingAdapter>([
  ['openai-text-embedding-3-small', new OpenAITextEmbedding3Small()],
  // Adopters register custom adapters here in their fork OR via a registration
  // hook exposed at orchestrator/src/embedding/extensions.ts (Phase 4).
]);

export function getEmbeddingAdapter(name: string): EmbeddingAdapter {
  const adapter = EMBEDDING_ADAPTERS.get(name);
  if (!adapter) {
    throw new UnknownEmbeddingProvider(name, [...EMBEDDING_ADAPTERS.keys()]);
  }
  return adapter;
}
```

Pipeline-load MUST fail with `UnknownEmbeddingProvider` if `Pipeline.spec.embedding.provider` names an adapter not present in the registry. This is fail-fast by design — silent fallback to the default adapter would mask operator typos and corrupt downstream vector storage.

### 6.2 Capability matrix

| Capability                | `openai-text-embedding-3-small` | `openai-text-embedding-3-large` (future) | `cohere-embed-v3` (future) | `local-onnx-bge-small` (future) |
| ------------------------- | ------------------------------- | ----------------------------------------- | --------------------------- | ------------------------------- |
| dimensions                | 1536                            | 3072                                      | 1024                        | 384                             |
| maxInputTokens            | 8191                            | 8191                                      | 512                         | 512                             |
| supportsBatching          | ✅ (up to 2048 inputs)          | ✅                                        | ✅                          | ✅                              |
| selfHosted                | ❌                              | ❌                                        | ❌                          | ✅                              |
| pricingModel              | per-token                       | per-token                                  | per-token                   | local (CPU/GPU cost only)       |
| approxCostPer1MTokens_USD | $0.02                           | $0.13                                     | $0.10                       | n/a                             |

The matrix is normative for adapters that ship in-tree. Adopter-registered adapters MUST extend this table in their fork or in a registry-side extension file so capability-aware consumers (e.g., the future `pickAdapterForJob()` heuristic) have data to reason over.

### 6.3 Capability declarations

Per RFC-0010 §13.8, capability declarations include `requires` for runtime dependencies:

```typescript
// orchestrator/src/embedding/adapters/openai-text-embedding-3-small.ts
readonly requires: EmbeddingRequires = {
  envVar: 'OPENAI_API_KEY',
  versionRange: undefined,    // SaaS — no client binary version to pin
};

// orchestrator/src/embedding/adapters/local-onnx-bge-small.ts (future)
readonly requires: EmbeddingRequires = {
  binary: 'onnxruntime-node',
  versionRange: '>=1.18.0',
  modelFile: 'bge-small-en-v1.5.onnx',
};
```

Pipeline-load validation runs `adapter.isAvailable()` for the configured provider AND fallback. If the primary returns `available: false`, pipeline-load FAILS with `EmbeddingProviderUnavailable` naming the `reason` and `detail` (e.g., "OPENAI_API_KEY env var not set; adapter `openai-text-embedding-3-small` requires it").

## 7. Default Adapter: openai-text-embedding-3-small

The reference implementation lives at `orchestrator/src/embedding/adapters/openai-text-embedding-3-small.ts`:

```typescript
export class OpenAITextEmbedding3Small implements EmbeddingAdapter {
  readonly name = 'openai-text-embedding-3-small';
  readonly modelId = 'text-embedding-3-small';
  readonly modelVersion = '2024-01-25';   // OpenAI's snapshot date
  readonly dimensions = 1536;
  readonly requires = { envVar: 'OPENAI_API_KEY' };

  async isAvailable(): Promise<EmbeddingAvailability> {
    if (!process.env.OPENAI_API_KEY) {
      return {
        available: false,
        reason: 'env-var-missing',
        detail: 'OPENAI_API_KEY not set; openai-text-embedding-3-small requires it.',
      };
    }
    return { available: true };
  }

  async embed(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('embed(): empty input rejected');
    }
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modelId,
        input: text,
        encoding_format: 'float',
      }),
    });
    if (!response.ok) {
      throw new EmbeddingProviderError(
        `openai embeddings API returned ${response.status}: ${await response.text()}`
      );
    }
    const data = await response.json() as OpenAIEmbeddingsResponse;
    const vector = data.data[0].embedding;
    if (vector.length !== this.dimensions) {
      throw new Error(
        `dimension mismatch: expected ${this.dimensions}, got ${vector.length}`
      );
    }
    // Cost tracking — see §10 + RFC-0004 integration.
    costTracker.record({
      lineItem: 'embeddingTokens',
      provider: this.name,
      tokens: data.usage.total_tokens,
      costUsd: data.usage.total_tokens * 0.00002 / 1000,  // $0.02 / 1M tokens
    });
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // OpenAI accepts up to 2048 inputs per call; orchestrator batches above that.
    // Implementation: same as embed() but with input: texts and returning data.data.map(d => d.embedding).
    // See actual implementation file for the full batch loop with chunking.
    // ...
  }

  async getAccountId(): Promise<string | null> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    return crypto.createHash('sha256').update(`${this.name}:${key}`).digest('hex');
  }
}
```

**Why `text-embedding-3-small` and not `-large`?** Per §3.2, v1 prioritizes cost-efficiency for the bootstrap use case (RFC-0009 OQ-6 drift). At $0.02 per 1M tokens, a 10K-token document embedded once costs $0.0002; a full corpus re-embed of 10K documents costs $2. The `-large` variant is 6.5× more expensive for marginal quality improvement on short-text drift detection. Adopters with quality-sensitive use cases (e.g., legal-document semantic search) MAY register the `-large` variant; the framework supports both.

**Why snapshot 2024-01-25?** It is OpenAI's most recent stable snapshot for `text-embedding-3-small` as of this RFC's authoring; the adapter source pins it explicitly. When OpenAI ships a new snapshot, the adapter version is bumped in code (PR-reviewed, not silent provider-side).

## 8. Vector Storage Schema

### 8.1 Entry shape

```typescript
interface VectorStoreEntry {
  vector: number[];                  // length === adapter.dimensions
  embeddingProvider: string;         // adapter.name at write time (e.g., 'openai-text-embedding-3-small')
  embeddingModelVersion: string;     // adapter.modelVersion at write time
  writtenAt: string;                 // ISO 8601 timestamp
  text: string;                      // original source text (REQUIRED — needed for re-embed during migration)
  textHash: string;                  // sha256(text) — used for read-side dedup and cache lookup
  metadata?: Record<string, unknown>; // adopter-defined; e.g., {sourceDoc: 'rfc-0009.md', shardId: 'OQ-6'}
}
```

**Why `text` is mandatory.** Migration (§9) requires re-embedding when the deprecated adapter is retired. Storing only the vector means the migration is impossible — there's nothing to re-embed. Storing the source text adds disk overhead but keeps migration tractable. Adopters with privacy concerns about retaining raw text MAY implement a custom storage backend that stores text in a separate, encrypted store; the framework requires `text` to be available at read time but does not mandate where it lives.

**Why `textHash` is separate from `text`.** Read-side deduplication (e.g., "have we already embedded this exact text?") uses the hash as a cache key. Recomputing the hash on every lookup is wasteful when storage is keyed on it. Adopters MAY use the hash for content-addressable storage (`<provider>-<modelVersion>/<textHash>.json`) instead of JSONL append.

### 8.2 Default backend: JSONL

```
<artifactsDir>/_embeddings/
├── openai-text-embedding-3-small-2024-01-25.jsonl
├── openai-text-embedding-3-large-2024-01-25.jsonl   (if multi-provider in use)
└── _index.json   (provider+version → file path map; written atomically on append)
```

One file per `(provider, modelVersion)` tuple. Append-only writes (matches the JSONL pattern in `_dor/calibration.jsonl`, `_deps/snapshot.jsonl`, etc.). GC by mtime — `cli-embedding-gc --older-than 90d` removes stale entries; the `_index.json` is rewritten to drop GC'd entries in the same atomic pass.

**Why JSONL?** Three reasons:

1. **Pattern consistency.** `_dor/`, `_deps/`, `_subscription-ledger/` all use JSONL append-only. Operators who debug one know how to debug all.
2. **Trivial inspection.** `jq` works out of the box; `grep` works for textHash lookup; no schema-migration story for v1.
3. **GC by mtime.** No vacuum step, no index rebuild — `find` + `rm` is the operational model.

The JSONL backend is intentionally not optimized for million-vector scales. Adopters with corpus sizes that exceed JSONL practicality (rough heuristic: >100K vectors per provider+version) are expected to swap in a sqlite or vector-DB backend via the `EmbeddingStorageBackend` interface (Phase 6+).

### 8.3 Storage backend interface

```typescript
interface EmbeddingStorageBackend {
  readonly name: string;             // 'jsonl', 'sqlite' (future), 'pgvector' (future)

  write(entry: VectorStoreEntry): Promise<void>;
  read(textHash: string, provider: string, modelVersion: string): Promise<VectorStoreEntry | null>;
  scan(filter: { provider?: string; modelVersion?: string }): AsyncIterator<VectorStoreEntry>;
  delete(textHash: string, provider: string, modelVersion: string): Promise<void>;
  count(filter: { provider?: string; modelVersion?: string }): Promise<number>;
}
```

The default JSONL backend implements `read` via linear scan + textHash match (acceptable up to ~100K entries; documented in the operator runbook). Adopter-supplied backends are free to use whatever indexing strategy fits their store.

## 9. Migration Mechanism

### 9.1 Deprecation lifecycle

When an adapter declares `deprecatedAt` (mirrors RFC-0010 §11 model alias pattern):

| Phase                              | Trigger                                       | Operator-facing behavior                                                                                                |
| ---------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Pre-deprecation**                | `today < deprecatedAt - 90d`                  | Silent. Adapter behaves normally.                                                                                       |
| **Warning period**                 | `deprecatedAt - 90d ≤ today < deprecatedAt`  | Pipeline-load emits `EmbeddingModelDeprecating` warning naming `replacementAlias`. Adapter still functions normally.   |
| **Deprecated**                     | `deprecatedAt ≤ today < removedAt`           | Pipeline-load emits `EmbeddingModelDeprecated` error in operator-strict mode; warning in default mode.                  |
| **Removed**                        | `removedAt ≤ today`                          | Pipeline-load FAILS with `EmbeddingModelRemoved` and the migration command (`cli-embedding-bump --to <replacementAlias>`). |

The 90d pre-warning is configurable via Q4 (§15); the values above are the leans.

### 9.2 The `cli-embedding-bump` tool

```
$ npx cli-embedding-bump --dry-run --to openai-text-embedding-3-large
Found 12,847 vectors on deprecated provider 'openai-text-embedding-ada-002'.
Estimated re-embed cost:
  Total tokens to re-embed: 4,312,891
  Provider rate (openai-text-embedding-3-large): $0.13 / 1M tokens
  Estimated cost: $0.56 USD
  Estimated wall-clock (at 100 req/sec, batched 2048 per call): ~21s
Run with --execute to perform migration.

$ npx cli-embedding-bump --execute --to openai-text-embedding-3-large
[1/3] Reading 12,847 vectors from openai-text-embedding-ada-002...    done (1.2s)
[2/3] Re-embedding via openai-text-embedding-3-large...                done (19.8s, $0.55)
[3/3] Atomic swap: writing _embeddings/openai-text-embedding-3-large-2024-01-25.jsonl...
       Original kept at _embeddings/openai-text-embedding-ada-002.jsonl.bak.<timestamp> for 30d.
Migration complete. 12,847 vectors migrated. Pipeline.spec.embedding.provider should now be set to 'openai-text-embedding-3-large'.
```

**Atomicity contract.** The migration writes the new JSONL file in full, then rewrites `_index.json` in a single atomic syscall (write-temp-then-rename). The original is preserved as `.bak.<timestamp>` for 30 days; `cli-embedding-gc` removes it after that window. Concurrent reads during migration MUST see either the pre-migration vectors (via the old index) or the post-migration vectors (via the new index), never a mix. The `_index.json` rename is the linearization point.

### 9.3 Read-side stale-vector policy

When a read encounters a vector whose `embeddingProvider` or `embeddingModelVersion` does not match the currently configured adapter, the read path follows `Pipeline.spec.embedding.staleVectorPolicy`:

- **`lazy-re-embed` (default lean per Q2):** orchestrator re-embeds the source text with the current adapter, writes the new entry to the current provider's JSONL, returns the new vector to the caller. First read amortizes the migration cost.
- **`fail-loud`:** orchestrator throws `StaleEmbeddingVector` with the offending entry's provider+version and the configured provider. Caller MUST handle (typically by surfacing to the operator and triggering `cli-embedding-bump`).
- **`warn`:** orchestrator emits a warning event but returns the stale vector as-is. Useful for read-mostly analytics where mixed-provider vectors are acceptable temporarily.

The policy is operator-configurable per pipeline; the default of `lazy-re-embed` favors operator convenience (slow first reads, no manual migration step) over strict provenance (fail-loud catches every stale vector at read time but requires explicit migration).

## 10. Configuration

### 10.1 `Pipeline.spec.embedding`

```yaml
spec:
  embedding:
    provider: openai-text-embedding-3-small      # adapter name (REQUIRED if section present)
    fallback: openai-text-embedding-3-small      # adapter to use if primary unavailable (optional; same as primary = no fallback)
    storageBackend: jsonl                         # 'jsonl' (default v1); future: 'sqlite', 'pgvector', 'qdrant'
    storageBackendConfig: {}                      # backend-specific config; opaque to the framework
    staleVectorPolicy: lazy-re-embed              # 'lazy-re-embed' (default) | 'fail-loud' | 'warn'
    autoEmbedOnWrite: true                        # whether write paths embed-and-store automatically (default true)
    maxBatchSize: 2048                            # adapter-specific cap; framework chunks above this
```

When `Pipeline.spec.embedding` is absent, the orchestrator behaves as if the framework is disabled — no vectors written, no providers loaded, consumers that depend on embeddings emit `EmbeddingProviderNotConfigured` (handled per consumer policy).

### 10.2 Feature flag

`AI_SDLC_EMBEDDING_PROVIDER` (mirrors `AI_SDLC_DEPS_COMPOSITION` and `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` patterns):

- Off by default in v1.
- Truthy values: `1`, `true`, `yes`, `on` (case-insensitive); anything else (including unset) is OFF.
- When OFF, `Pipeline.spec.embedding` is ignored and consumers emit `EmbeddingProviderDisabled`.
- When ON, the framework loads per `Pipeline.spec.embedding`.

Promotion to default-on follows the same corpus-driven pattern as RFC-0014 Phase 5: framework promotes when (a) at least one consumer has shipped a feature that depends on it, AND (b) at least one full corpus window has run with embeddings enabled without operator-reported regressions.

## 11. Implementation Plan

Five phases. Critical path: 1 → 2 → 3/4 (parallel) → 5.

### Phase 1 — Adapter interface + registry + OpenAI default (1 week)

- `orchestrator/src/embedding/types.ts` (interface)
- `orchestrator/src/embedding/registry.ts` (registry + getEmbeddingAdapter)
- `orchestrator/src/embedding/adapters/openai-text-embedding-3-small.ts` (default adapter)
- `orchestrator/src/embedding/errors.ts` (UnknownEmbeddingProvider, EmbeddingProviderUnavailable, etc.)
- Unit tests: registry round-trip, adapter dimension validation, isAvailable() probe behavior
- Schema: `spec/schemas/embedding-adapter.v1.schema.json`

**Exit criteria:** unit tests pass; `getEmbeddingAdapter('openai-text-embedding-3-small')` returns a working adapter when `OPENAI_API_KEY` is set; pipeline-load fails with structured error when adapter is unknown.

### Phase 2 — Vector storage + JSONL backend (0.5 week)

- `orchestrator/src/embedding/storage/types.ts` (`EmbeddingStorageBackend`)
- `orchestrator/src/embedding/storage/jsonl-backend.ts` (default backend)
- `orchestrator/src/embedding/storage/index.ts` (backend factory keyed on `Pipeline.spec.embedding.storageBackend`)
- `cli-embedding-gc` for retention (mtime-based)
- Unit tests: write→read round-trip; concurrent-write atomicity; GC behavior; index rewrite atomicity

**Exit criteria:** can write 1K entries, read by textHash in <100ms median, GC removes >90d entries cleanly.

### Phase 3 — Migration tooling (`cli-embedding-bump`) (1 week)

- `pipeline-cli/bin/cli-embedding-bump.mjs` (entry point)
- `--dry-run` mode: count + cost estimate
- `--execute` mode: read-old → re-embed → atomic-swap → keep .bak
- Read-side stale-vector policy implementation (lazy-re-embed | fail-loud | warn)
- Integration tests: deprecation lifecycle (warning → error → removal); migration round-trip; mid-migration concurrent read returns consistent result

**Exit criteria:** `cli-embedding-bump --dry-run` produces accurate cost estimate; `--execute` is atomic under concurrent reads; deprecation lifecycle phases trigger correct operator-facing events.

### Phase 4 — Pipeline integration + Pipeline.spec.embedding schema (0.5 week)

- Schema amendment: add `Pipeline.spec.embedding` per §10.1
- Pipeline-load wires `Pipeline.spec.embedding` → registry lookup → adapter instantiation → storage backend instantiation
- First downstream consumer integration: `Eτ_tessellation_drift` rule from RFC-0009 OQ-6 (pending RFC-0009 implementation; spec-level wiring lands in Phase 4, runtime usage lands when RFC-0009 ships)
- Cost-tracker integration: `embeddingTokens` line item per RFC-0004
- Operator runbook: `docs/operations/embedding-providers.md`

**Exit criteria:** end-to-end pipeline run with `AI_SDLC_EMBEDDING_PROVIDER=on` writes vectors during a stage that calls `embed()`; cost-tracker records `embeddingTokens` line items.

### Phase 5 — Soak + deprecation flag promotion (corpus-driven)

- Run dogfood pipeline with embeddings enabled for at least one full corpus window
- Verify: no operator-reported regressions; storage growth matches expectations; cost-tracker aligns with provider invoice
- Promote `AI_SDLC_EMBEDDING_PROVIDER` to default-on (operator-dispatched per the RFC-0014 promotion runbook pattern)

**Exit criteria (per RFC-0014 model — corpus-driven, NOT calendar-driven):**
- At least one downstream consumer shipped that depends on the framework, AND
- One full corpus window with the framework enabled completes without operator-flagged regressions.

## 12. Schema Changes

### 12.1 `Pipeline.spec.embedding` (new optional field)

Per §10.1. Optional; absent = framework disabled.

### 12.2 New schema: `spec/schemas/embedding-adapter.v1.schema.json`

JSON Schema for the `EmbeddingAdapter` interface — used by adopter adapters that want machine-checkable conformance. Schema lints adapter source via a future `cli-embedding-validate-adapter` (post-v1, out of scope here).

### 12.3 `VectorStoreEntry` shape

Per §8.1. New schema file: `spec/schemas/vector-store-entry.v1.schema.json` — used by storage backends to validate entries on write.

### 12.4 Cost-tracker line item: `embeddingTokens`

Amends RFC-0004 §4 cost-attribution categories with a new line item for embedding-API spend. Tracked per `(provider, modelVersion, accountId)` tuple.

## 13. Backward Compatibility

- v1 ships behind `AI_SDLC_EMBEDDING_PROVIDER` feature flag, **default OFF**. Existing pipelines without `Pipeline.spec.embedding` continue to function unchanged.
- No existing pipeline today has an embedding consumer wired in; the first consumer (RFC-0009 OQ-6 drift) is itself in Draft and will land behind a separate flag.
- The schema amendment (§12.1) adds an OPTIONAL field; pipelines without it are valid.
- The cost-tracker amendment (§12.4) adds a new line item; existing line-item consumers ignore unknown items per RFC-0004 conventions.

## 14. Alternatives Considered

### 14.1 Local sentence-transformers via ONNX as the v1 default

**Rejected for v1.** Adds an `onnxruntime-node` dependency (or worse, a Python sidecar), pulls down a 100MB+ model file on first run, and shifts responsibility for model files into the orchestrator's installation footprint. The bootstrap use case (RFC-0009 OQ-6 drift, with corpus sizes in the low thousands of documents) doesn't warrant this complexity. ONNX-backed local adapters remain a Phase 6+ extension point — the interface is designed to support them, but they don't ship in v1.

**Reconsider when:** the orchestrator runs in air-gapped environments where outbound API calls are prohibited, OR when embedding cost dominates pipeline cost (very large corpora). Neither is true for the bootstrap use case.

### 14.2 Anthropic embeddings API

**Rejected: doesn't exist as of this RFC's authoring.** Anthropic's roadmap does not currently include an embeddings endpoint. If/when that changes, an `anthropic-text-embedding-*` adapter is a 100-line addition to the registry — the framework supports it, no spec change needed.

### 14.3 Claude/GPT as a semantic distance oracle (no embeddings at all)

**Rejected: wrong shape.** Asking an LLM "how semantically similar are these two texts on a 0-1 scale" is a known-bad pattern. LLMs are inconsistent at numerical distance computation, expensive per call (vs $0.02/1M tokens for embeddings), and the resulting "distances" are not metrically valid (no triangle inequality, no symmetry guarantee). The right tool for this job is an embedding model + cosine similarity; this RFC ships exactly that.

### 14.4 Standardize on a single hard-coded provider

**Rejected: violates the "adapters all the way down" framework principle.** RFC-0010 §13/§15 already established the pattern; deviating here would create an inconsistent operator experience. The framework adds <500 lines of adapter-machinery code; the maintenance cost of a single hard-coded provider would be lower in week 1 and higher by week 12 (when the first adopter wants to swap providers).

### 14.5 Vector database as the v1 storage backend

**Rejected for v1, deferred to Phase 6+.** pgvector, Qdrant, Pinecone, etc. each add a service dependency, an authentication story, and a backup/restore story. JSONL has none of those — `git diff` on the file is the audit trail, `cp` is the backup, `rm` is the cleanup. v1 ships JSONL; the storage-backend interface (§8.3) keeps the door open for vector-DB backends in adopter forks today and in-tree later.

## 15. Open Questions

The operator (dominique) will walk through these before promoting the RFC out of Draft. Each question lists the lean to enable concrete Phase 1 work to begin.

### Q1: Vector storage backend for v1 — JSONL vs sqlite?

**Lean: JSONL.** Mirrors `_dor/calibration.jsonl`, `_deps/snapshot.jsonl`, `_subscription-ledger/*.jsonl` patterns; trivial to inspect with `jq`/`grep`; GC by mtime; no schema-migration story to author. sqlite would give us indexed lookups but adds a real migration story and breaks the "one cat command shows you the data" debugging pattern.

**Decide before Phase 2.**

### Q2: Stale-vector policy default — lazy-re-embed vs fail-loud?

**Lean: lazy-re-embed.** Operator-friendly: pipelines keep working after an adapter swap, slow first-reads amortize the migration cost across actual usage, no manual `cli-embedding-bump --execute` step required for the common case. Strict-provenance shops can flip to `fail-loud` via config. The risk with `lazy-re-embed` as default is that it masks accidental adapter swaps — but the PR-level adapter-swap is loud (config change) so the masking risk is low.

**Decide before Phase 4.**

### Q3: Cross-provider compatibility — explicit no-op or auto-migrate?

**Lean: explicit no-op.** Vectors from `openai-text-embedding-3-small` (1536 dims) are NOT comparable to vectors from `openai-text-embedding-3-large` (3072 dims) even within the same provider family. The framework MUST refuse to compare across `(provider, modelVersion)` boundaries; adopters who change adapters MUST run `cli-embedding-bump`. Auto-migration on read is technically possible (the `lazy-re-embed` policy in Q2 already does it on a per-vector basis) but framework-level "magic" cross-provider migration would obscure the identity-of-vectors invariant.

**Decide before Phase 3.**

### Q4: Embedding provider deprecation grace period?

**Lean: 90d warning + hard removal at `removedAt`.** OpenAI typically gives 12-month deprecation notices; 90d framework-side warning is conservative within that window. Concrete schedule:
- Warning starts: 90 days before `deprecatedAt` (configurable to a smaller value in pipeline config for fast-moving providers; 90d is the default lean).
- Error starts: at `deprecatedAt` (operator-strict mode); warning continues in default mode.
- Pipeline-load FAILS: at `removedAt`; operator MUST run `cli-embedding-bump` to migrate.

**Decide before Phase 1.**

### Q5: Where in `pipeline-cli` vs `orchestrator` does the framework live?

**Lean: orchestrator.** RFC-0010's HarnessAdapter and DatabaseBranchAdapter both live under `orchestrator/src/<surface>/`. Embedding adapters are the same shape (interface + registry + lifecycle + invocation); they belong in the same package for consistency. The `cli-embedding-bump` and `cli-embedding-gc` CLIs live under `pipeline-cli/bin/` (CLI conventions are pipeline-cli-side per existing pattern), but the framework code itself lives in orchestrator.

**Decide before Phase 1.**

### Q6: Token budget tracking for embedding calls?

**Lean: yes, embedded under `embeddingTokens` line item in cost-tracker.** OpenAI charges per token embedded; the framework MUST track this against `Pipeline.spec.costBudget`. New line item `embeddingTokens` (not conflated with `inputTokens`/`outputTokens` from harness calls) — keeps the cost-attribution story clean for adopters who want to break out embedding spend separately.

**Decide before Phase 1** (Phase 1 ships the cost-tracker integration alongside the OpenAI default adapter so the very first vector written records cost correctly).

### Q7: How does this interact with RFC-0010 SubscriptionLedger?

**Lean: track separately, don't conflate.** Embedding API calls are pay-per-token (OpenAI bills against the API key directly), not subscription-quota-based. The SubscriptionLedger (RFC-0010 §14) tracks Claude Code Max / Codex subscription windows; embedding spend is a separate dollar-denominated cost that surfaces under cost-tracker's `embeddingTokens` line item. Conflating them would distort burn-down pacing in §14.4 (subscription quota would appear consumed by embedding calls that don't actually count against it).

**Decide before Phase 4** (ledger interaction matters when pipeline-level budgeting decisions are made).

## 16. References

- **RFC-0010 §13** (Harness Adapter Framework) — structural template for the interface + registry + capability matrix + validation pattern. RFC-0019 mirrors this section's shape verbatim.
- **RFC-0010 §11** (Per-stage model routing) — alias deprecation lifecycle (warning → error → removal) cloned to embedding model deprecation.
- **RFC-0010 §15** (DatabaseBranchAdapter) — second adapter framework precedent; confirms the pattern as the orchestrator's standard for pluggable provider integrations.
- **RFC-0009 OQ-6 rule #2** (Eτ_tessellation_drift via embedding distance) — the primary use case driving this RFC. Without RFC-0019, the OQ-6 drift signal cannot be computed.
- **RFC-0004** (Cost Governance and Attribution) — cost-tracker integration point for the new `embeddingTokens` line item.
- **RFC-0014** (Dependency Graph Composition) — reference for the corpus-driven flag-promotion pattern reused in Phase 5.

## 17. Sign-Off

- [ ] Engineering owner — dominique@reliablegenius.io (pending)
- [x] Product owner — Alexander Kline (2026-05-04)
- [ ] Operator owner — dominique@reliablegenius.io (pending)

## 18. Revision History

| Version | Date       | Author    | Notes                                                                                                                                |
| ------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| v1      | 2026-05-03 | dominique | Initial draft per RFC-0009 OQ-6 sub-decision; mirrors RFC-0010 §13 harness adapter pattern + §11 alias deprecation lifecycle.        |
