/**
 * RFC-0024 capture record types + validators.
 *
 * The capture record is the atomic unit of the emergent issue capture pattern.
 * Records are written to `$ARTIFACTS_DIR/_captures/<id>.jsonl` — one file per
 * capture, never modified after write (immutable). The `auditTrail` field
 * accumulates state transitions via a separate triage action rather than
 * in-place mutation.
 *
 * @module capture/capture-record
 */

// ── Enums ────────────────────────────────────────────────────────────────────

/** RFC-0024 §6 — severity levels available at capture time. */
export type CaptureSeverity = 'critical' | 'major' | 'minor' | 'suggestion' | 'unknown';

/**
 * RFC-0024 §7 — triage dispositions. Fixed enum so the framework can
 * route deterministically. Adding values requires a spec change.
 *
 * - `tbd`              captured but operator hasn't decided (surfaces in TUI Blockers)
 * - `new-issue`        separate contract, normal scope
 * - `new-feature-issue` upstream design work required
 * - `scope-extension`  belongs in current issue's AC list
 * - `quick-fix`        small scope, ships standalone or with current work
 * - `framework-bug`    framework misbehaved (per RFC-0025)
 * - `not-actionable`   known limitation, expected behavior, won't fix
 */
export type CaptureTriageValue =
  | 'tbd'
  | 'new-issue'
  | 'new-feature-issue'
  | 'scope-extension'
  | 'quick-fix'
  | 'framework-bug'
  | 'not-actionable';

/** Agent roles that can file captures. */
export type AgentRole =
  | 'code-reviewer'
  | 'test-reviewer'
  | 'security-reviewer'
  | 'developer'
  | 'orchestrator';

// ── Audit trail entry ────────────────────────────────────────────────────────

export interface AuditEntry {
  /** Action taken (captured, triaged, issue-created, feature-issue-created, redacted, etc.). */
  action: string;
  /** Actor: operator email, agent role, or 'framework'. */
  by: string;
  /** ISO-8601 UTC timestamp. */
  at: string;
  /** Optional extra fields (e.g. issueId for issue-created entries). */
  [key: string]: unknown;
}

// ── Capture record ───────────────────────────────────────────────────────────

export interface CaptureSource {
  /** Who produced this capture. */
  type: 'operator' | 'ai-agent';
  /** Agent role (null for operator captures). */
  agentRole?: AgentRole | null;
  /** Operator email/login (null for agent captures). */
  operator?: string | null;
  /** Free-text context: what the source was doing when this surfaced. */
  context?: string;
}

export interface CaptureEvidence {
  /** Repo-relative path to the file where the finding was observed. */
  filePath?: string | null;
  /** 1-based line number within filePath. */
  line?: number | null;
  /** GitHub PR number if the finding originated in a PR. */
  prNumber?: number | null;
  /** GitHub PR review comment URL. */
  commentUrl?: string | null;
  /** Git commit SHA providing context. */
  commitSha?: string | null;
  /** Free-text additional context. */
  additionalContext?: string;
}

/**
 * RFC-0024 §6 capture record schema (v1).
 * Immutable once written — triage updates produce new audit entries, not mutations.
 */
export interface CaptureRecord {
  /** Monotonic + random suffix ID: `cap_YYYY-MM-DDTHH-MM-SS_<hex>`. */
  id: string;
  /** Schema version — always 'v1'. */
  schemaVersion: 'v1';
  /** ISO-8601 UTC timestamp at capture time. */
  timestamp: string;
  /** One-line description of the emergent issue. */
  finding: string;
  /** Operator-estimated severity at capture time. */
  severity: CaptureSeverity;
  /** Triage disposition. 'tbd' until the operator triages. */
  triage: CaptureTriageValue;
  /** Who produced this capture. */
  source: CaptureSource;
  /** Evidence linking the finding to source context. */
  evidence: CaptureEvidence;
  /** Adapter-native issue ID this capture is filed against (optional). */
  relatedIssueId?: string | null;
  /** Target issue ID when triage='scope-extension'. */
  extensionTargetIssueId?: string | null;
  /** Feature Issue path/URL when triage='new-feature-issue'. */
  featureIssueCarveRef?: string | null;
  /** Issue ID gated by this finding (triggers decision-deferred handoff). */
  blocksIssueId?: string | null;
  /** Populated when an Issue is created from this capture. */
  createdIssueId?: string | null;
  /** Populated when a Feature Issue is created from this capture. */
  createdFeatureIssueId?: string | null;
  /** Populated when triage flips from 'tbd' to a terminal value. */
  resolvedAt?: string | null;
  /** Operator/agent that resolved the triage. */
  resolvedBy?: string | null;
  /** Immutable append-only audit log of state transitions. */
  auditTrail: AuditEntry[];
}

// ── Validators ───────────────────────────────────────────────────────────────

export const VALID_SEVERITIES: readonly CaptureSeverity[] = [
  'critical',
  'major',
  'minor',
  'suggestion',
  'unknown',
];

export const VALID_TRIAGE_VALUES: readonly CaptureTriageValue[] = [
  'tbd',
  'new-issue',
  'new-feature-issue',
  'scope-extension',
  'quick-fix',
  'framework-bug',
  'not-actionable',
];

export const TERMINAL_TRIAGE_VALUES: readonly CaptureTriageValue[] = [
  'new-issue',
  'new-feature-issue',
  'scope-extension',
  'quick-fix',
  'framework-bug',
  'not-actionable',
];

/** True when the triage value is a terminal disposition (not 'tbd'). */
export function isTerminalTriage(triage: CaptureTriageValue): boolean {
  return TERMINAL_TRIAGE_VALUES.includes(triage);
}

/**
 * Structural validation — checks required fields + enum membership.
 * Returns an error string on the first violation, or null if the record is valid.
 */
export function validateCaptureRecord(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const r = raw as Record<string, unknown>;

  if (typeof r.id !== 'string' || r.id.length === 0) return 'id: missing or not a string';
  if (r.schemaVersion !== 'v1') return 'schemaVersion: must be "v1"';
  if (typeof r.timestamp !== 'string') return 'timestamp: missing or not a string';
  if (typeof r.finding !== 'string' || r.finding.length === 0) return 'finding: missing or empty';
  if (!VALID_SEVERITIES.includes(r.severity as CaptureSeverity))
    return `severity: must be one of ${VALID_SEVERITIES.join('|')}`;
  if (!VALID_TRIAGE_VALUES.includes(r.triage as CaptureTriageValue))
    return `triage: must be one of ${VALID_TRIAGE_VALUES.join('|')}`;
  if (!r.source || typeof r.source !== 'object') return 'source: missing or not an object';
  const src = r.source as Record<string, unknown>;
  if (src.type !== 'operator' && src.type !== 'ai-agent')
    return 'source.type: must be operator|ai-agent';
  if (!r.evidence || typeof r.evidence !== 'object') return 'evidence: missing or not an object';
  if (!Array.isArray(r.auditTrail)) return 'auditTrail: missing or not an array';

  return null;
}

// ── ID generation ────────────────────────────────────────────────────────────

/**
 * Generate a capture ID in the format `cap_YYYY-MM-DDTHH-MM-SS_<hex6>`.
 * The timestamp portion is monotonic (wall clock); the hex suffix adds
 * entropy so concurrent captures in the same second don't collide.
 */
export function generateCaptureId(now: Date = new Date()): string {
  const iso = now.toISOString().slice(0, 19).replace(/:/g, '-');
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `cap_${iso}_${hex}`;
}
