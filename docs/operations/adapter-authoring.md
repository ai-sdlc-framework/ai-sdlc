# Authoring a HarnessAdapter

**Audience:** AI-SDLC maintainers adding support for a new coding-agent runtime (Gemini CLI, OpenCode, Aider, etc.).
**Status:** Draft v1
**Companion to:** [RFC-0010 §13](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md)

---

## Overview

The HarnessAdapter framework decouples the orchestrator from any single coding-agent runtime. Each adapter declares static capabilities, a binary requirement with version range, and three runtime methods (`getAccountId`, `isAvailable`, `invoke`). Adapters are in-tree only — third-party plugins are NOT supported in v1 because adapters execute external CLIs with full credential scope.

The two adapters shipped with v1 are `claude-code` and `codex`. Adding a new adapter follows a five-step recipe.

## Recipe

### 1. Implement the adapter

Create `orchestrator/src/harness/adapters/<name>.ts` implementing the `HarnessAdapter` interface:

```typescript
import type {
  HarnessAdapter,
  HarnessAvailability,
  HarnessCapabilities,
  HarnessEvent,
  HarnessInput,
  HarnessName,
  HarnessRequires,
  HarnessResult,
} from '../types.js';

export class GeminiCliAdapter implements HarnessAdapter {
  readonly name: HarnessName = 'gemini-cli';

  readonly capabilities: HarnessCapabilities = {
    freshContext: true,
    customTools: false,
    streaming: true,
    worktreeAwareCwd: true,
    skills: false,
    artifactWrites: true,
    maxContextTokens: 2_000_000,
  };

  readonly requires: HarnessRequires = {
    binary: 'gemini',
    versionRange: '>=1.0.0',          // open-ended upper bound by default
    versionProbe: {
      args: ['--version'],
      parse: (stdout) => stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? '',
    },
  };

  async getAccountId(): Promise<string | null> { /* derive from env */ }
  async isAvailable(): Promise<HarnessAvailability> { /* run version probe */ }
  async invoke(input: HarnessInput, onEvent?: (e: HarnessEvent) => void): Promise<HarnessResult> { /* drive the CLI */ }
  async availableModels(): Promise<string[]> { /* list models the binary can drive */ }
}
```

### 2. Honor the capability matrix accurately

The static `capabilities` field is **authoritative for pipeline-load validation** (RFC §13.4). Lying about a capability — declaring `customTools: true` when the binary doesn't actually support MCP — produces silent runtime failures the operator can't debug. Verify each capability against the upstream CLI's documented behavior before declaring it `true`.

### 3. Implement `getAccountId`

The orchestrator keys the SubscriptionLedger on `(harness, accountId, tenant)` so two pipelines on the same vendor account auto-pool. Derive the id from credentials in `process.env`:

```typescript
async getAccountId(): Promise<string | null> {
  const env = this.deps.env ?? process.env;
  const token = env.GEMINI_API_KEY;
  if (!token) return null;
  return createHash('sha256')
    .update(`gemini-cli:${token}`)  // namespace by harness name
    .digest('hex')
    .slice(0, 16);
}
```

Three rules (non-negotiable):
1. **NEVER include the credential itself in the returned id.** Hash, then truncate.
2. **NAMESPACE the hash by harness name.** Two harnesses sharing a credential file MUST produce different ids.
3. **Return null when no credential is discoverable.** The orchestrator emits `LedgerKeyAmbiguous` and degrades to per-pipeline keying — that's the right behavior for harnesses without a stable identity.

### 4. Use the version probe for `isAvailable`

```typescript
import { probeVersion } from '../version-probe.js';

async isAvailable(): Promise<HarnessAvailability> {
  if (this.cachedAvailability) return this.cachedAvailability;
  const result = await probeVersion(this.requires);
  this.cachedAvailability = result;
  return result;
}
```

Cache the result for the orchestrator's lifetime — operators restart to pick up newly-installed binaries. Do NOT cache across orchestrator restarts.

Per RFC §13.8, parse failures fall through to `available: true` with `reason: 'probe-failed'` so undocumented vendor changes to `--version` output don't break every pipeline.

### 5. Register the adapter

Update `orchestrator/src/harness/index.ts`:

```typescript
import { GeminiCliAdapter } from './adapters/gemini-cli.js';

export function createDefaultHarnessRegistry(): HarnessRegistry {
  const reg = new HarnessRegistry();
  reg.register(new ClaudeCodeAdapter());
  reg.register(new CodexAdapter());
  reg.register(new GeminiCliAdapter());  // ← new line
  return reg;
}
```

Also extend the `HarnessName` union in `types.ts` if your adapter introduces a new harness identifier.

## Testing checklist

Every new adapter MUST ship with unit tests (`adapters/<name>.test.ts`) covering:

- [ ] All capability fields explicitly asserted (RFC §13.3 matrix is normative)
- [ ] `requires.binary` and `versionRange` declarations
- [ ] `getAccountId` deterministic for same env
- [ ] `getAccountId` differs across credentials
- [ ] `getAccountId` returns null on missing credentials
- [ ] `getAccountId` namespaces by harness name (cross-harness key isolation)
- [ ] `getAccountId` never returns the credential
- [ ] `isAvailable` honors injected probe
- [ ] `isAvailable` caches result
- [ ] `availableModels` returns the canonical list

Reference: `orchestrator/src/harness/adapters/claude-code.test.ts` and `codex.test.ts`.

## Security review requirements

Adapters execute external CLIs with full credential scope. The maintainer review for any new adapter MUST verify:

1. **No credential leakage in error messages.** Errors from the underlying CLI are wrapped before re-throwing.
2. **No credential in logs.** Adapter never `console.log`s the credential or any string derived from it (other than the `getAccountId` hash).
3. **Environment scrubbed before invocation.** When dispatching, the agent process MUST receive a curated env, not the orchestrator's full env. Other harnesses' credentials in particular MUST NOT leak into a fallback invocation.
4. **`invoke` failures map cleanly to `HarnessResult.status`.** Distinguish `unavailable` (vendor outage / API down) from `failure` (the agent ran but produced wrong output) — fallback chain depends on this distinction.

## Capability matrix maintenance

The capability matrix in [RFC-0010 §13.3](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) is normative. When adding an adapter, update the table with the new column. The matrix is the source-of-truth doc operators consult when authoring pipelines.

## Out of scope (Phase 2.7)

Two pieces of the adapter contract are stubbed in Phase 2.7 and complete in later phases:

- **`invoke` end-to-end execution.** The default `invoke` throws `not wired into dispatch yet`. Phase 3 (concurrency + worker pool) routes dispatch through the adapter registry.
- **Schema-conformant artifact emission.** Per RFC §13.9, adapters MUST validate any JSON artifacts they produce against `spec/schemas/artifacts/<name>.schema.json`. The artifact schemas land in Phase 4.

When implementing a new adapter today, you can ship the static capabilities + version probe + getAccountId + availableModels and leave `invoke` stubbed (matching Claude Code and Codex's pattern). Phase 3 will populate the dispatch path uniformly across all adapters.
