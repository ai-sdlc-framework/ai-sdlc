# Review Calibration API

The review calibration system reduces false positives through deterministic
preprocessing, structured reasoning, meta-review filtering, and feedback tracking.

## Import

```typescript
import {
  // AST preprocessor
  analyzeDiff,
  extractChangedFiles,
  type DiffFinding,
  type DiffAnalysisResult,

  // Meta-review
  metaReview,
  ReviewFeedbackStore,
  type MetaReviewDecision,
  type MetaReviewResult,
  type ReviewFeedback,

  // Review execution
  executeReview,
  type ReviewContext,
  type ReviewOptions,
} from '@ai-sdlc/orchestrator';
```

---

## AST Preprocessor

### `analyzeDiff(diff, repoPath)`

Run deterministic structural checks on files changed in a PR diff.

```typescript
async function analyzeDiff(
  diff: string,       // Unified diff text
  repoPath: string,   // Absolute path to repo root
): Promise<DiffAnalysisResult>;
```

**Returns:**

```typescript
interface DiffAnalysisResult {
  changedFiles: string[];     // All files in the diff
  findings: DiffFinding[];    // Structural issues found
  summary: string;            // Formatted for injection into review context
}

interface DiffFinding {
  type: 'complexity' | 'imports' | 'file-length';
  file: string;
  severity: 'info' | 'warning';
  message: string;
}
```

**Checks performed:**

| Check | Threshold | Severity |
|---|---|---|
| File complexity | Score 7+/10 | warning |
| Large file | 300+ lines (500+ = warning) | info/warning |
| Import count | 15+ imports | warning |

### `extractChangedFiles(diff)`

Parse file paths from a unified diff.

```typescript
function extractChangedFiles(diff: string): string[];
```

---

## Structured Review Output

Review agents produce findings with confidence and evidence:

```typescript
interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  file?: string;
  line?: number;
  message: string;
  confidence?: number;    // 0-1, below 0.5 auto-suppressed
  category?: 'logic-error' | 'security' | 'design' | 'performance' | 'testing' | 'other';
  evidence?: {
    codePathTraced?: string;     // How execution reaches the issue
    failureScenario?: string;    // Concrete failure description (required for critical/major)
  };
}
```

**Confidence thresholds:**

| Range | Action |
|---|---|
| >= 0.8 | Post directly to PR |
| 0.5 - 0.8 | Meta-review pass (if configured) |
| < 0.5 | Automatically suppressed |

---

## Meta-Review

### `metaReview(verdict, principles, callLLM)`

Filter medium-confidence findings through a lightweight LLM verification pass.

```typescript
async function metaReview(
  verdict: ReviewVerdict,          // Original verdict from review agent
  principles: string,              // Review principles text
  callLLM: (prompt: string) => Promise<string>,  // Single-turn LLM caller
): Promise<MetaReviewResult>;
```

**Parameters:**
- `verdict` — The review verdict to filter
- `principles` — Review principles text (from `.ai-sdlc/review-principles.md`)
- `callLLM` — Function that makes a single-turn LLM call (e.g., Haiku)

**Returns:**

```typescript
interface MetaReviewResult {
  verdict: ReviewVerdict;   // Filtered verdict
  decisions: Array<{
    finding: ReviewFinding;
    decision: MetaReviewDecision;
  }>;
  suppressed: number;       // Count of findings removed
}

interface MetaReviewDecision {
  keep: boolean;
  adjustedSeverity?: ReviewFinding['severity'];
  reason: string;
}
```

**Behavior:**
- High confidence (>= 0.8): Passes through without LLM call
- Medium confidence (0.5 - 0.8): Each finding gets a meta-review call
- Meta-review failure: Finding is kept conservatively
- All findings suppressed: Verdict is auto-approved
- Legacy findings (no confidence): Treated as high confidence

### Example

```typescript
const result = await metaReview(
  verdict,
  readFileSync('.ai-sdlc/review-principles.md', 'utf-8'),
  async (prompt) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const body = await res.json();
    return body.content[0].text;
  },
);
```

---

## Feedback Store

### `ReviewFeedbackStore`

Tracks human accept/dismiss signals for calibration.

```typescript
class ReviewFeedbackStore {
  record(feedback: ReviewFeedback): void;
  getAll(): ReviewFeedback[];
  precision(): number;                    // accepted / (accepted + dismissed)
  byCategory(): Record<string, { accepted: number; dismissed: number; ignored: number }>;
  highFalsePositiveCategories(): string[];  // Categories with >50% dismiss rate (min 3 samples)
}

interface ReviewFeedback {
  prNumber: number;
  finding: ReviewFinding;
  signal: 'accepted' | 'dismissed' | 'ignored';
  timestamp: string;
}
```

---

## Review Execution with Meta-Review

### `executeReview(prNumber, diff, reviewType, context, options)`

The `options` parameter now accepts meta-review configuration:

```typescript
interface ReviewOptions {
  apiConfig?: Omit<ReviewAgentConfig, 'reviewType'>;
  logger?: Logger;
  runner?: ReviewAgentRunner;
  principles?: string;                              // For meta-review context
  metaReviewLLM?: (prompt: string) => Promise<string>;  // Enables meta-review
}
```

When both `principles` and `metaReviewLLM` are provided, medium-confidence
findings are automatically filtered through the meta-review pass before the
verdict is returned.

---

## Calibration Files

| File | Purpose |
|---|---|
| `.ai-sdlc/review-policy.md` | Golden rule, CI boundary table, threat model, severity definitions |
| `.ai-sdlc/review-principles.md` | 7 durable principles (evidence-first, deterministic-first, etc.) |
| `.ai-sdlc/review-exemplars.yaml` | 20 labeled examples (true bugs, false positives, borderline cases) |

To calibrate a new false positive: add an exemplar to `review-exemplars.yaml`.
No code changes needed.
