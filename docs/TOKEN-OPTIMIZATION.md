# AI-SDLC Token Optimization Guide

This document describes the four major token optimizations implemented to reduce Claude API costs while maintaining review quality.

## 1. Repository Map Strategy (Biggest Saving)

**Problem:** Sending entire repository state on every review wastes tokens.

**Solution:** Build a lightweight repository structure map once, reference it instead of scanning all files.

### Implementation

```typescript
import { buildRepoMap, formatRepoMapForPrompt } from './analysis/repo-map-builder';

const map = buildRepoMap('/path/to/repo');
const mapPrompt = formatRepoMapForPrompt(map);
```

### What Gets Included

- Directory structure (top 3 levels)
- Detected conventions (TypeScript, monorepo, Docker, etc.)
- Key modules and packages
- File counts and size metrics

### What Gets Excluded

- `node_modules/`, `.git/`, `.next/`, `dist/`, `build/`, etc.
- Binary files, media, archives
- Non-essential directories

### Expected Savings

- **Before:** 50k-200k tokens per review (entire repo context)
- **After:** 2k-5k tokens per review (map only)
- **Savings:** 95% reduction for large codebases

---

## 2. Summary → Detailed Escalation

**Problem:** Agents receive everything upfront, even context they don't need.

**Solution:** Send only a lightweight summary. Agents escalate explicitly when they need details.

### Implementation

```typescript
import { buildContextSummary, formatSummaryForPrompt } from './analysis/context-escalation';

const summary = buildContextSummary(
  filesChanged,
  testsChanged,
  acceptanceCriteria,
  references,
  hasNewDependencies,
  hasSchemaChanges,
);
```

### What Gets Included in Summary

- File count, test count, complexity estimate
- Acceptance criteria and reference counts
- Flags for new dependencies or schema changes

### Escalation Pattern

If an agent needs full diff details, test files, or dependency analysis:

```
ESCALATE: full-diff because acceptance criteria require understanding
the database migration pattern used in the existing codebase
```

### Expected Savings

- **Before:** Full context + all references sent upfront
- **After:** Summary only (300-500 tokens), details on demand
- **Savings:** 60-80% for low-complexity tasks

---

## 3. Don't Send Previous Agent Conversations

**Problem:** Reusing full transcripts from previous iterations wastes tokens.

**Solution:** Extract only actionable findings; discard reasoning and verbose output.

### Implementation

```typescript
import { filterAgentHistory, formatFilteredHistoryForPrompt } from './runtime/agent-history-filter';

const filtered = filterAgentHistory(agentHistory, maxEntries = 3);
const historyPrompt = formatFilteredHistoryForPrompt(filtered);
```

### What Gets Extracted

- One-sentence summary of each attempt
- Action items only (no reasoning)
- Outcome (success/failure/escalation)

### What Gets Discarded

- Full prompts
- Complete agent reasoning
- Chat-style back-and-forth
- Token usage details

### Expected Savings

- **Before:** 20k-50k tokens per iteration (full transcript)
- **After:** 1k-2k tokens per iteration (summary)
- **Savings:** 95% reduction on iteration rounds

---

## 4. Tiered Security Review by PR Size

**Problem:** Running full security review on 50-line PR wastes tokens.

**Solution:** Route PRs to appropriate review tier based on size and risk.

### Tiers

| Tier | Lines Changed | Scope | Est. Tokens |
|------|---------------|-------|-------------|
| Lightweight | 0-300 | Style, obvious bugs, test existence | 2k |
| Standard | 301-600 | Logic, design, security, tests | 5k |
| Full | 601-1000 | Comprehensive review | 12k |
| Split-required | >1000 | Reject, request author split | 0 |

### Implementation

```typescript
import { determineReviewTier, getReviewScope } from './runners/tiered-review-router';

const metrics = {
  linesAdded: 150,
  linesRemoved: 50,
  filesChanged: 3,
  hasSchemaChange: false,
  hasCriticalFiles: false,
};

const tier = determineReviewTier(metrics);
// Returns 'lightweight' for small changes
```

### Escalation Rules

Critical files (auth, security, database) and schema changes always escalate to `full` review,  regardless of line count.

### Expected Savings

- **Before:** 12k tokens per PR (all full reviews)
- **After:** Tiered costs (2k-12k depending on size)
- **Savings:** 70-80% for typical PR distribution

---

## Overall Impact

Combining all four optimizations:

| Scenario | Before | After | Savings |
|----------|--------|-------|---------|
| Small change (100 lines) | 15k | 2.5k | 83% |
| Medium change (400 lines) | 20k | 5k | 75% |
| Large change (800 lines) | 35k | 12k | 66% |
| Code review iteration | 50k | 3k | 94% |

**Monthly savings on a typical project:** 60-70% reduction in API tokens.

---

## Configuration

All optimizations are opt-in and configurable:

```typescript
// In orchestrator config
const reviewConfig = {
  repoMapThresholdBytes: 50_000_000, // Build map if repo > 50MB
  escalationEnabled: true, // Enable summary-first strategy
  maxAgentHistoryEntries: 3, // Keep last 3 attempts only
  reviewTierConfig: {
    lightweightThreshold: 300,
    standardThreshold: 600,
    fullThreshold: 1000,
  },
};
```

---

## Monitoring

Track token savings:

```typescript
// Log before/after tokens for each review
logger.info('Review tokens', {
  prSize: 'medium',
  tier: 'standard',
  tokensEstimated: 5000,
  tokensSaved: 15000,
  savingsPercent: 75,
});
```

---

## Rollout Plan

1. **Phase 1:** Repo map builder + testing
2. **Phase 2:** Escalation strategy on dev agent
3. **Phase 3:** Agent history filtering on iterations
4. **Phase 4:** Tiered review router in review agents
5. **Phase 5:** Monitor + adjust thresholds

Estimated token savings after full rollout: **60-75%**
