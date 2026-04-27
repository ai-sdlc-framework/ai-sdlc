# Tutorial 9: Review Agent Calibration

AI-SDLC review agents use a **deterministic-first, LLM-second** architecture
to minimize false positives without hand-tuning rules. This tutorial explains
how the system works and how to calibrate it for your project.

---

## The Problem

Traditional LLM review agents flag everything — lint issues, type errors,
coverage gaps, style preferences — producing noise that drowns out real bugs.
Hand-tuning rules to suppress false positives doesn't scale: the rule list
grows unbounded and rules interact unpredictably.

## The Solution: Three Layers

```
PR Diff
  │
  ├─→ [Deterministic] CI/CD (lint, typecheck, test, coverage)
  │     └─→ Pass/fail — no LLM needed
  │
  ├─→ [Deterministic] AST Preprocessor (complexity, file length, imports)
  │     └─→ Structural findings — flagged before LLM review
  │
  └─→ [LLM] Review Agents (only what's left)
        ├─→ CI Boundary (skip what CI covers)
        ├─→ Structured reasoning (evidence + confidence required)
        ├─→ 7 Principles + Exemplar bank
        ├─→ Confidence filtering (<0.5 suppressed)
        └─→ Meta-review (medium confidence → Haiku verification)
```

---

## Step 1: CI Boundary

Every review agent prompt includes a **CI Boundary** section that lists
exactly what CI checks handle. Agents are told to skip those categories:

| CI Check | What It Covers | Agent Scope? |
|---|---|---|
| ESLint | Lint violations, unused imports | No |
| Prettier | Formatting, whitespace | No |
| TypeScript build | Type errors, generics | No |
| Vitest | Test failures | No |
| Codecov | Line coverage (80% patch) | No |

Agents focus on what CI **cannot** catch: logic errors, security, design, and
acceptance criteria gaps.

---

## Step 2: AST Preprocessor

Before the LLM sees the diff, the `DiffAnalyzer` runs deterministic structural
checks on changed files:

- **File complexity** — Scores each file 1-10 using line count + import count.
  Files scoring 7+ are flagged as high-complexity.
- **Large files** — Flags files exceeding 300 lines.
- **Import count** — Flags files with 15+ imports as high coupling.

These findings are prepended to the review context as "Pre-Verified Structural
Analysis" — agents skip re-analyzing structural properties.

```typescript
import { analyzeDiff } from '@ai-sdlc/orchestrator';

const result = await analyzeDiff(prDiff, repoPath);
// result.findings — deterministic structural issues
// result.summary — formatted for injection into review context
```

---

## Step 3: Structured Reasoning

Review agents produce findings with **confidence scores** and **evidence**:

```json
{
  "severity": "major",
  "confidence": 0.85,
  "category": "logic-error",
  "file": "src/auth.ts",
  "line": 42,
  "evidence": {
    "codePathTraced": "login() calls verifyToken() which returns null on expired tokens",
    "failureScenario": "User with expired token gets null, line 42 accesses .userId causing TypeError"
  },
  "message": "Null pointer: verifyToken result used without null check"
}
```

**Key rules:**
- Findings below **0.5 confidence** are automatically suppressed
- **Critical/major** findings MUST include a `failureScenario`
- "No evidence = no critical/major finding"

---

## Step 4: Principles + Exemplars

Instead of 21+ hand-tuned rules, the system uses **7 principles** and a bank
of **20 labeled examples**.

### The 7 Principles

1. **Evidence-First** — Trace the code path or don't flag it
2. **Deterministic-First** — Defer to CI for lint, types, coverage
3. **Trust Boundaries** — Only flag at real untrust boundaries
4. **Context Awareness** — Read surrounding code before flagging
5. **Severity Honesty** — No failureScenario = not critical/major
6. **Signal Over Noise** — One good finding beats ten bad ones
7. **Scope Discipline** — Don't flag deferred work or unchanged code

### Exemplar Bank

Stored in `.ai-sdlc/review-exemplars.yaml`:

```yaml
exemplars:
  - id: null-pointer-on-regex-match
    type: true-positive
    category: logic-error
    diff: |
      +  const result = data.match(/pattern/);
      +  return result.groups.name;
    verdict: "critical — result can be null, causing TypeError"
    principle: evidence-first

  - id: json-parse-trusted-config
    type: false-positive
    category: security
    diff: |
      +  const config = JSON.parse(readFileSync('.ai-sdlc/config.yaml'));
    verdict: "not a vulnerability — trusted project config"
    principle: trust-boundaries
```

**To calibrate a new false positive:** Add an exemplar to the YAML file.
No code changes needed.

---

## Step 5: Meta-Review Pass

Medium-confidence findings (0.5-0.8) go through a lightweight **meta-review**
— a second Haiku LLM call that evaluates: "Is this a real issue or noise?"

```typescript
import { metaReview } from '@ai-sdlc/orchestrator';

const result = await metaReview(verdict, principles, callLLM);
// result.verdict — filtered verdict
// result.suppressed — count of findings removed
// result.decisions — keep/drop decision for each finding
```

The meta-reviewer receives the finding, evidence, and principles, then returns:
- `keep: true` — post the finding
- `keep: false` — suppress as noise
- `adjustedSeverity` — optionally downgrade the severity

---

## Step 6: Feedback Flywheel

Track how humans respond to review comments:

| Signal | Meaning |
|---|---|
| **Accept** (human fixes the issue) | True positive |
| **Dismiss** (human dismisses the review) | False positive |
| **Ignore** (merged without addressing) | Low-value |

```typescript
import { ReviewFeedbackStore } from '@ai-sdlc/orchestrator';

const store = new ReviewFeedbackStore();
store.record({ prNumber: 42, finding, signal: 'dismissed', timestamp: new Date().toISOString() });

store.precision();                    // accepted / (accepted + dismissed)
store.highFalsePositiveCategories();  // categories with >50% dismiss rate
```

Over time, the feedback data calibrates confidence thresholds and identifies
categories that need new exemplars.

---

## Summary

| Layer | Type | What it does |
|---|---|---|
| CI/CD | Deterministic | Lint, typecheck, tests, coverage |
| AST Preprocessor | Deterministic | File complexity, length, imports |
| CI Boundary | Prompt engineering | Agents skip CI-covered categories |
| Structured Reasoning | LLM output | Confidence scores + evidence required |
| Principles + Exemplars | Few-shot | 7 principles + 20 labeled examples |
| Meta-Review | LLM filter | Haiku verifies medium-confidence findings |
| Feedback Flywheel | Human-in-loop | Accept/dismiss calibrates thresholds |

---

## Next Steps

- **[Action Governance](/docs/api-reference/governance)** — How blockedActions enforcement works
- **[Claude Code Plugin](/docs/tutorials/08-claude-code-plugin)** — Zero-config governance installation
- **[SDK Runner](/docs/api-reference/sdk-runner)** — Programmatic agent control with budget caps
