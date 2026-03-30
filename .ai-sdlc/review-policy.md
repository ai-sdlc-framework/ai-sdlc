# AI-SDLC Review Policy

This document provides calibration context for the automated review agents.
Read this before analyzing any PR to avoid false positives.

## Threat Model

### Trusted Input Sources (do NOT flag for injection)
- `.ai-sdlc/*.yaml` pipeline configuration files — these are committed by maintainers
- `orchestrator/src/defaults.ts` constants — hardcoded values
- Notification templates from `pipeline.yaml` `spec.notifications.templates`
- Agent role constraints from `agent-role.yaml`

### Untrusted Input Sources (DO flag for injection)
- Issue titles and bodies from GitHub (user-submitted)
- PR bodies and review comments
- Slack message content
- CLI arguments from external callers
- Agent output (filesChanged, summary)

## Regex Patterns — When to Flag ReDoS

**DO NOT flag** these patterns as ReDoS vulnerabilities:
- Bounded character classes: `[a-z0-9-]{0,30}` — linear time, no backtracking
- Fixed-length quantifiers: `\d{1,15}` — bounded, cannot backtrack
- Character classes without alternation: `[a-zA-Z0-9/_.-]+` — no ambiguity

**DO flag** these patterns:
- Nested quantifiers with alternation: `(a+)+$`, `(a|aa)+`
- Unbounded repetition on overlapping groups: `(\w+\s*)*`
- Patterns where the engine can match the same input multiple ways

The key test: can the regex engine take exponentially different paths for the same input? If no, it's safe.

## Concurrency and Race Conditions

**DO NOT flag** as race conditions:
- Sequential `await` calls in the same async function — these execute in order
- In-memory state within a single function invocation — no concurrent access
- Cloudflare Worker module-level variables — Workers handle one request at a time per isolate

**DO flag** as race conditions:
- Shared state across GitHub Actions workflow runs (use comment markers for coordination)
- Multiple workflows writing to the same branch simultaneously
- State that depends on external API calls being atomic (they're not)

## Code Quality Calibration

### Severity Classification
- **critical**: Logic error that causes data loss, security breach, or infinite loop in production
- **major**: Bug that affects correctness in common paths, or security issue with a plausible attack vector
- **minor**: Code quality issue that doesn't affect correctness but should be improved
- **suggestion**: Nice-to-have improvement with no correctness impact

### Common False Positives to Avoid
- "Empty catch block" when the catch has a comment explaining why it's intentional (best-effort operations)
- "Missing error handling" on best-effort operations (Slack notifications, telemetry) — these should not fail the pipeline
- "Information disclosure" for internal stage names in Slack messages to a private channel with trusted developers
- "Unsafe JSON.parse" when the input is from a controlled source (our own API response format)

## Testing Standards

### What Requires Test Coverage
- All public functions and their error paths
- Integration points between modules
- Cycle detection thresholds and boundary conditions

### What Does NOT Require Test Coverage
- Thin CLI wrappers that parse args and call orchestrator functions (tested via the orchestrator tests)
- GitHub Actions workflow YAML (tested by running the workflow)
- `console.error` logging statements in catch blocks
