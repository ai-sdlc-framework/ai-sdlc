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

## Getting Help

- **[API Reference](api-reference/)** -- Full SDK reference
- **[Specification](../spec/spec.md)** -- Normative requirements
- **[GitHub Issues](https://github.com/ai-sdlc-framework/ai-sdlc/issues)** -- Report bugs or request features
