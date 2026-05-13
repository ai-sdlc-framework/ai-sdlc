# Troubleshooting

Common issues, solutions, and reference information for the AI-SDLC Framework.

## Validation Errors

### "Missing 'kind' field"

Every resource MUST include `apiVersion`, `kind`, `metadata`, and `spec` at the top level.

```yaml
# Wrong — missing kind
apiVersion: ai-sdlc.io/v1alpha1
metadata:
  name: my-pipeline
spec: ...

# Correct
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: my-pipeline
spec: ...
```

### "Unknown resource kind"

The `kind` field must be one of: `Pipeline`, `AgentRole`, `QualityGate`, `AutonomyPolicy`, `AdapterBinding`. Values are case-sensitive.

### Schema validation fails with no useful message

Use `validate()` with an explicit kind instead of `validateResource()` for better error reporting:

```typescript
// More specific error messages
const result = validate('Pipeline', doc);
```

### "additionalProperties" errors

The JSON schemas use `additionalProperties: false` in some locations. Check for typos in field names:

```yaml
# Wrong — 'trigger' is not valid, should be 'triggers'
spec:
  trigger:
    - event: issue.assigned

# Correct
spec:
  triggers:
    - event: issue.assigned
```

## Builder Gotchas

### Builder produces empty stages array

`addStage()` returns `this` for chaining. If you forget to chain or call `build()`:

```typescript
// Wrong — build() called on new builder, not the chain
const builder = new PipelineBuilder('test');
builder.addStage({ name: 'implement', agent: 'code-agent' });
const pipeline = new PipelineBuilder('test').build(); // Empty!

// Correct
const pipeline = new PipelineBuilder('test')
  .addStage({ name: 'implement', agent: 'code-agent' })
  .build();
```

### AdapterBindingBuilder requires all four constructor arguments

Unlike other builders, `AdapterBindingBuilder` needs interface, type, and version upfront:

```typescript
// Wrong — missing arguments
const binding = new AdapterBindingBuilder('github').build();

// Correct
const binding = new AdapterBindingBuilder('github', 'SourceControl', 'github', '1.0.0').build();
```

## Duration Format

Duration strings are used in health checks, timeouts, cooldowns, and minimum durations.

### Shorthand format

Pattern: `<number><unit>` where unit is one of:

| Unit | Meaning | Example |
|---|---|---|
| `s` | seconds | `300s` (5 minutes) |
| `m` | minutes | `5m` |
| `h` | hours | `2h` |
| `d` | days | `1d` |
| `w` | weeks | `2w` |

### ISO 8601 format

Also supported: `P[nD][T[nH][nM][nS]]`

| Example | Meaning |
|---|---|
| `P1D` | 1 day |
| `PT1H` | 1 hour |
| `PT30M` | 30 minutes |
| `P1DT12H` | 1 day 12 hours |

### Common mistakes

```yaml
# Wrong — no unit
timeout: 300

# Wrong — space between number and unit
timeout: 300 s

# Wrong — plural units
timeout: 5mins

# Correct
timeout: 300s
timeout: 5m
```

## Enforcement

### Gate fails but pipeline continues

If the enforcement level is `advisory`, failures are logged but do not block. Check the enforcement level:

```typescript
const result = enforce(gate, context);
for (const r of result.results) {
  if (r.verdict === 'fail' && r.enforcement === 'advisory') {
    // This failure was logged but did not block
    console.log(`Advisory failure: ${r.gate}`);
  }
}
```

### Override not working for soft-mandatory gate

Overrides require both conditions:
1. The `overrideRole` in the context must match `gate.override.requiredRole`
2. If `requiresJustification` is true, `overrideJustification` must be provided

```typescript
const result = enforce(gate, {
  // ...
  overrideRole: 'engineering-manager',
  overrideJustification: 'Emergency hotfix for production outage',
});
```

### Hard-mandatory gate cannot be overridden

By design. Even if you provide override credentials, hard-mandatory gates always block on failure. Demote the gate to soft-mandatory if overrides are needed.

## Autonomy Evaluation

### Agent not eligible for promotion despite meeting metrics

Check these conditions in order:

1. **Minimum duration** -- Has the agent been at the current level long enough? Check `minimumDuration` on the level definition.
2. **Demotion cooldown** -- Was the agent recently demoted? The cooldown period must expire before promotion is considered.
3. **Task count** -- Has the agent completed enough tasks? Check `minimumTasks` in the promotion criteria.
4. **Metric conditions** -- Are all metric thresholds met?
5. **Required approvals** -- Have all required human approvals been granted?

```typescript
const result = evaluatePromotion(policy, agentMetrics);
console.log(result.unmetConditions); // Lists exactly what's missing
```

## Adapter Issues

### "Secret not found" or undefined config values

Ensure environment variables are set using `UPPER_SNAKE_CASE`:

```bash
# secretRef: jira-api-token → JIRA_API_TOKEN
export JIRA_API_TOKEN="your-token-here"

# secretRef: github-token → GITHUB_TOKEN
export GITHUB_TOKEN="ghp_..."
```

### Adapter health check failing

Verify the adapter endpoint is reachable and credentials are valid. Check the health check configuration:

```yaml
healthCheck:
  interval: 60s   # Must be valid duration
  timeout: 10s    # Must be less than interval
```

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `AI_SDLC_MODEL` | Default LLM model for agent operations | `claude-sonnet-4-5-20250929` |
| `AI_SDLC_LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` |
| `GITHUB_TOKEN` | GitHub API token for adapters | (required for GitHub adapters) |
| `LINEAR_API_KEY` | Linear API key for issue tracking | (required for Linear adapter) |

## Common Test Failures

### Tests fail with "Cannot find module"

Build the reference implementation first:

```bash
pnpm --filter @ai-sdlc/reference build
pnpm test
```

### Schema validation tests fail after type changes

Regenerate or update JSON schemas to match type changes, then rebuild:

```bash
pnpm --filter @ai-sdlc/reference validate-schemas
```

## Admission Confidence

### Confidence stuck at or below 0.5 with fully-loaded inputs

**Symptom:** `overallConfidence` stays at `~0.5` even when DID + DSB +
maintainers + soul-tracks all loaded without errors. The admission engine never
recommends the high-conviction fast path.

**Root cause (AISDLC-267 / AISDLC-172):** The admission confidence formula
blends two independent evidence channels in a 50/50 split:

1. **Mapper coverage** — fraction of 9 issue-signal fields that
   `mapIssueToPriorityInput` extracted from the issue/backlog entry (soul
   alignment, demand signal, consensus, conviction, complexity, bug severity,
   explicit priority, competitive drift, customer request count).

2. **Enrichment loaded** — fraction of 5 RFC-0008 enrichment slots present on
   the input: `designSystemContext` (DSB loader), `autonomyContext` (DID/
   AutonomyPolicy loader), `codeAreaQuality` (code-area metrics loader),
   `designAuthoritySignal` (maintainers loader), and `soulAlignmentOverride`
   (soul-tracks SA-1 loader).

Each loaded enrichment reader contributes `+0.1` to confidence (1/5 × 0.5
weight). If all five readers report success, the enrichment channel reaches its
maximum of `0.5`, and with full mapper coverage (~7-9 fields), the combined
confidence reaches `0.75-0.9`.

**How to inspect which fields are populated:**

```typescript
import {
  mapIssueToPriorityInput,
  computeAdmissionConfidence,
} from '@ai-sdlc/orchestrator';

const priorityInput = mapIssueToPriorityInput(admissionInput);

// Mapper coverage: which of the 9 fields did the mapper extract?
const ADMISSION_MAPPER_FIELDS = [
  'soulAlignment', 'demandSignal', 'teamConsensus', 'builderConviction',
  'complexity', 'bugSeverity', 'explicitPriority', 'competitiveDrift',
  'customerRequestCount',
] as const;
for (const field of ADMISSION_MAPPER_FIELDS) {
  console.log(`${field}: ${priorityInput[field] !== undefined ? priorityInput[field] : '(not set)'}`);
}

// Enrichment coverage: which readers loaded context?
const enrichmentSlots = {
  designSystemContext: admissionInput.designSystemContext,
  autonomyContext: admissionInput.autonomyContext,
  codeAreaQuality: admissionInput.codeAreaQuality,
  designAuthoritySignal: admissionInput.designAuthoritySignal,
  soulAlignmentOverride: options?.soulAlignmentOverride,
};
for (const [slot, value] of Object.entries(enrichmentSlots)) {
  console.log(`${slot}: ${value !== undefined ? 'loaded' : 'missing'}`);
}

const confidence = computeAdmissionConfidence(admissionInput, priorityInput, options);
console.log(`confidence: ${confidence}`); // target: >= 0.7 with all 5 readers
```

**Common causes and fixes:**

| Symptom | Cause | Fix |
|---|---|---|
| Confidence ~0.39 with all readers loaded | Using old `computeConfidence(priorityInput)` from `priority.ts` directly | Use `computeAdmissionConfidence` from `admission-composite.ts` instead |
| Confidence ~0.39, no enrichment readers | All 5 enrichment slots undefined on `AdmissionInput` | Wire the DSB / DID / maintainers / soul-tracks loaders into your `enrichAdmissionInput()` call |
| Confidence ~0.5, only mapper fields | Enrichment readers are called but result is not attached to `AdmissionInput` | Confirm each reader's output is passed as the correct `AdmissionInput` field |
| Confidence < 0.5 even with full inputs | `bugSeverity` or `explicitPriority` absent (no `bug`/priority label) | Expected — these are genuinely optional; 7/9 mapper coverage + 5/5 enrichment yields ~0.79 |

**Confidence bands and their meaning:**

| Range | Interpretation |
|---|---|
| `>= 0.7` | High-conviction — all enrichment readers loaded + good mapper coverage |
| `0.5 – 0.69` | Medium — enrichment partially loaded or mapper fields sparse |
| `< 0.5` | Low — most enrichment slots empty (no readers configured) |
| `0` | Veto — `soulAlignment = 0` (Draft / security-rejected / Needs Clarification) |

**Note:** If the `minimumConfidence` threshold on your admission gate is set
higher than the confidence your enrichment setup can produce, lower the threshold
or add the missing enrichment readers. The high-conviction threshold used by the
fast-path policy is typically `0.7`.

## Getting Help

- **[API Reference](api-reference/)** -- Full SDK reference
- **[Specification](../spec/spec.md)** -- Normative requirements
- **[GitHub Issues](https://github.com/ai-sdlc-framework/ai-sdlc/issues)** -- Report bugs or request features
