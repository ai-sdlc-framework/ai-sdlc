/**
 * DoR per-project config loader (RFC-0011 §13 Q5/Q6 + §9.3).
 *
 * Phase 3 (AISDLC-115.4) wires the orchestration layer to the on-disk
 * `.ai-sdlc/dor-config.yaml`. Phase 1 already shipped the JSON schema
 * (`spec/schemas/dor-config.v1.schema.json`); this module parses + lifts
 * the relevant slices into a typed shape the comment loop and staleness
 * sweeper can consume directly.
 *
 * Intentional scope: this is a thin reader, NOT a full schema validator.
 * Producer-side validation lives in CI (the schema sits in `spec/`).
 * The reader applies sensible defaults when fields are missing so the
 * orchestration layer can run against a freshly-bootstrapped repo with
 * zero config.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DorConfigStaleness {
  warnAfterDays: number;
  closeAfterDays: number;
  closedLabel: string;
}

/**
 * Escalation policy (RFC-0011 §6.3 + Phase 6 / AISDLC-115.7).
 *
 * Triggers:
 *   - Author hasn't responded after `maxRoundsBeforeHumanTriage` clarification
 *     rounds (default 3 per RFC §6.3).
 *   - Verdict is `overallConfidence: 'low'` (per Q4 — never auto-act on low
 *     confidence; route to a human triager via the same path as the round-
 *     limit escalation).
 *
 * `triager` is the routing target — a Slack channel, a Slack user mention, a
 * GitHub team handle, or a free-form string the orchestration layer knows
 * how to interpret. When escalation fires but no triager is configured, the
 * `decideEscalation()` helper still returns the decision but stamps
 * `unrouted: true` so the calling shim can surface a loud warning instead
 * of silently dropping the alert.
 */
export interface DorConfigEscalation {
  /** Round count at which to escalate. Default 3 (RFC §6.3). */
  maxRoundsBeforeHumanTriage: number;
  /**
   * Human / channel to ping when the escalation fires. Free-form so the
   * orchestration layer can resolve `@github-team`, `#slack-channel`, or
   * a plain user identity uniformly. Optional — a missing triager makes
   * the escalation `unrouted` rather than throwing, so the gate never
   * blocks the pipeline solely on a missing config field.
   */
  triager?: string;
}

export interface DorConfigDedicatedChannel {
  slack?: string;
  github_team?: string;
}

export interface DorConfigNotifications {
  /** When true, post the clarification comment to where the issue was authored. Default `true`. */
  authorChannel: boolean;
  /** Optional centralised triage channel(s). When set, posts go to BOTH author + dedicated. */
  dedicatedChannel?: DorConfigDedicatedChannel;
}

export type DorEvaluationMode = 'warn-only' | 'enforce';

/**
 * Auto-pass rule (RFC §6.4 + Phase 4 / AISDLC-115.5).
 *
 * Each rule names an issue shape that doesn't need full rubric evaluation.
 * Per Alex's Addition 1 (Product sign-off) the rule may EITHER skip every
 * gate (legacy behaviour — empty `gatesSkipped` + empty `gatesRetained`)
 * OR carve out a specific subset (e.g. `signal-pipeline-generated` skips
 * gates 1/4/5/6 — surface naming, AC testability, scope, done-state — but
 * retains 2/3/7 — markers, references, dependencies — because those still
 * apply to auto-generated tasks).
 */
export interface AutoPassRule {
  /** Stable rule identifier — `signal-pipeline-generated`, `dependency-bump`, etc. */
  kind: string;
  /** Author identities that trigger this rule (may match `IssueInput.authorIdentity`). */
  sources: string[];
  /** Optional regex (JS flavour) the issue title must match. */
  titlePattern?: string;
  /** Optional cap on body diff size in lines (used by doc-typo). */
  maxBodyDiffLines?: number;
  /** Gate IDs (1-7) the rule auto-passes (skips). Empty array = skip all gates. */
  gatesSkipped: number[];
  /** Gate IDs (1-7) still evaluated when the rule matches. Empty array = retain none. */
  gatesRetained: number[];
}

export interface DorConfig {
  rubricVersion: 'v1';
  evaluationMode: DorEvaluationMode;
  notifications: DorConfigNotifications;
  staleness: DorConfigStaleness;
  /** Auto-pass shortcuts (RFC §6.4 + Phase 4). Order matters — first match wins. */
  autoPassRules: AutoPassRule[];
  /** Escalation policy (RFC §6.3 + Phase 6). */
  escalation: DorConfigEscalation;
  /** Trusted-reviewer role required to apply the dor-bypass label (RFC §7.4). */
  bypassRequiresRole: string;
}

/**
 * Defaults used when the on-disk config is missing or partially specified.
 * Mirrors the JSON schema defaults (RFC §13 Q6 + §9.3). Values here must
 * stay in sync with `spec/schemas/dor-config.v1.schema.json` defaults.
 */
export const DOR_CONFIG_DEFAULTS: DorConfig = {
  rubricVersion: 'v1',
  evaluationMode: 'warn-only',
  notifications: {
    authorChannel: true,
  },
  staleness: {
    warnAfterDays: 14,
    closeAfterDays: 28,
    closedLabel: 'closed-as-stale-dor',
  },
  autoPassRules: [],
  escalation: {
    maxRoundsBeforeHumanTriage: 3,
  },
  bypassRequiresRole: 'maintainer',
};

export interface LoadDorConfigOpts {
  /** Project root. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Override the on-disk path (tests). */
  filePath?: string;
}

/**
 * Resolve the canonical config path. Honors explicit `filePath` first,
 * then `<workDir>/.ai-sdlc/dor-config.yaml`.
 */
export function resolveDorConfigPath(opts: LoadDorConfigOpts = {}): string {
  if (opts.filePath) return opts.filePath;
  const workDir = opts.workDir ?? process.cwd();
  return join(workDir, '.ai-sdlc', 'dor-config.yaml');
}

/**
 * Load + normalise the per-project DoR config. Missing files fall back
 * to {@link DOR_CONFIG_DEFAULTS}; partial files merge field-by-field.
 *
 * Parsing intentionally uses a small line-based YAML reader rather than
 * pulling in `js-yaml` — the config is flat, the schema is fixed, and we
 * already lean on the schema validator in CI to enforce shape. Keeps
 * the package's runtime dependency surface tiny (currently just
 * `yargs`).
 */
export function loadDorConfig(opts: LoadDorConfigOpts = {}): DorConfig {
  const path = resolveDorConfigPath(opts);
  if (!existsSync(path)) return { ...DOR_CONFIG_DEFAULTS };
  const raw = readFileSync(path, 'utf8');
  return parseDorConfigYaml(raw);
}

/**
 * Parse a DoR config YAML string into a `DorConfig`. Public so tests
 * can drive the parser without touching the filesystem.
 *
 * Supported subset of YAML:
 *   - Top-level `apiVersion`, `kind`, `spec` keys (only `spec` is read).
 *   - Nested `spec.rubricVersion`, `spec.evaluationMode`,
 *     `spec.notifications.authorChannel`,
 *     `spec.notifications.dedicatedChannel.slack/github_team`,
 *     `spec.staleness.warnAfterDays/closeAfterDays/closedLabel`,
 *     `spec.escalation.maxRoundsBeforeHumanTriage/triager`,
 *     `spec.bypassRequiresRole` (RFC §6.3 + §7.4 + Phase 6).
 *   - Booleans (`true`/`false`), integers, and quoted/unquoted scalars.
 *
 * Anything else is silently ignored — the schema validator catches
 * malformed configs at PR time.
 */
export function parseDorConfigYaml(yaml: string): DorConfig {
  const out: DorConfig = JSON.parse(JSON.stringify(DOR_CONFIG_DEFAULTS));
  // Track the section we're currently inside via indentation depth.
  // This is not a full YAML parser; it handles the flat-ish DoR config
  // shape and rejects nothing — schema validation lives in CI.
  const lines = yaml.split('\n');
  const stack: { indent: number; key: string }[] = [];
  // Auto-pass rules are list-of-objects — a shape the simple flat parser
  // doesn't handle. Buffer the `autoPassRules:` section verbatim and
  // delegate to a small dedicated reader (see `parseAutoPassRules`).
  const autoPassBuffer: string[] = [];
  let autoPassBaseIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    // Detect entry into the autoPassRules block (the key is opened with
    // no inline value and the next non-blank lines are list items at a
    // greater indent). Buffer until the indent drops back to the parent.
    if (autoPassBaseIndent >= 0) {
      const indent = rawLine.length - rawLine.trimStart().length;
      const isBlank = !rawLine.trim();
      if (isBlank) {
        autoPassBuffer.push(rawLine);
        continue;
      }
      if (indent > autoPassBaseIndent) {
        autoPassBuffer.push(rawLine);
        continue;
      }
      // Section ended — flush.
      out.autoPassRules = parseAutoPassRules(autoPassBuffer);
      autoPassBuffer.length = 0;
      autoPassBaseIndent = -1;
      // Fall through to process this line normally.
    }

    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const line = rawLine.trim();
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1).trim();
    const path = stack.map((s) => s.key);

    if (key === 'autoPassRules' && path.length === 1 && path[0] === 'spec' && !valueRaw) {
      autoPassBaseIndent = indent;
      continue;
    }

    if (!valueRaw) {
      stack.push({ indent, key });
      continue;
    }

    applyValue(out, [...path, key], stripQuotes(valueRaw));
  }

  if (autoPassBaseIndent >= 0) {
    out.autoPassRules = parseAutoPassRules(autoPassBuffer);
  }

  return out;
}

/**
 * Parse the `spec.autoPassRules:` list block. Accepts the documented
 * subset:
 *
 *   - kind: signal-pipeline-generated
 *     sources: ['ai-sdlc/signal-pipeline']
 *     gatesSkipped: [1, 4, 5, 6]
 *     gatesRetained: [2, 3, 7]
 *
 * (Inline-flow arrays only; nested block lists aren't worth the parser
 * complexity for the rule shape we ship.)
 */
function parseAutoPassRules(lines: string[]): AutoPassRule[] {
  const rules: AutoPassRule[] = [];
  let current: Partial<AutoPassRule> | null = null;

  const flush = (): void => {
    if (!current) return;
    rules.push({
      kind: String(current.kind ?? ''),
      sources: current.sources ?? [],
      titlePattern: current.titlePattern,
      maxBodyDiffLines: current.maxBodyDiffLines,
      gatesSkipped: current.gatesSkipped ?? [],
      gatesRetained: current.gatesRetained ?? [],
    });
    current = null;
  };

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('- ')) {
      flush();
      current = {};
      const after = trimmed.slice(2);
      // Inline `- key: value` form.
      const colonIdx = after.indexOf(':');
      if (colonIdx > 0) {
        const k = after.slice(0, colonIdx).trim();
        const v = after.slice(colonIdx + 1).trim();
        applyAutoPassField(current, k, v);
      }
      continue;
    }
    if (!current) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const k = trimmed.slice(0, colonIdx).trim();
    const v = trimmed.slice(colonIdx + 1).trim();
    applyAutoPassField(current, k, v);
  }
  flush();
  return rules;
}

function applyAutoPassField(target: Partial<AutoPassRule>, key: string, valueRaw: string): void {
  const value = stripQuotes(valueRaw);
  switch (key) {
    case 'kind':
      target.kind = value;
      return;
    case 'sources':
      target.sources = parseInlineStringArray(valueRaw);
      return;
    case 'titlePattern':
      target.titlePattern = value;
      return;
    case 'maxBodyDiffLines':
      target.maxBodyDiffLines = parseIntStrict(value);
      return;
    case 'gatesSkipped':
      target.gatesSkipped = parseInlineIntArray(valueRaw);
      return;
    case 'gatesRetained':
      target.gatesRetained = parseInlineIntArray(valueRaw);
      return;
    default:
      // Silently ignore unknown keys (CI schema validator catches them).
      return;
  }
}

function parseInlineStringArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((s) => stripQuotes(s.trim()));
}

function parseInlineIntArray(raw: string): number[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((s) => parseIntStrict(s.trim()))
    .filter((n) => Number.isFinite(n));
}

function applyValue(target: DorConfig, path: string[], raw: string): void {
  const [a, b, c, d] = path;
  if (a === 'spec' && b === 'rubricVersion') {
    if (raw === 'v1') target.rubricVersion = 'v1';
    return;
  }
  if (a === 'spec' && b === 'evaluationMode') {
    if (raw === 'warn-only' || raw === 'enforce') target.evaluationMode = raw;
    return;
  }
  if (a === 'spec' && b === 'notifications' && c === 'authorChannel') {
    target.notifications.authorChannel = raw === 'true';
    return;
  }
  if (a === 'spec' && b === 'notifications' && c === 'dedicatedChannel' && d) {
    target.notifications.dedicatedChannel ??= {};
    if (d === 'slack') target.notifications.dedicatedChannel.slack = raw;
    if (d === 'github_team') target.notifications.dedicatedChannel.github_team = raw;
    return;
  }
  if (a === 'spec' && b === 'staleness' && c) {
    if (c === 'warnAfterDays') target.staleness.warnAfterDays = parseIntStrict(raw);
    else if (c === 'closeAfterDays') target.staleness.closeAfterDays = parseIntStrict(raw);
    else if (c === 'closedLabel') target.staleness.closedLabel = raw;
    return;
  }
  if (a === 'spec' && b === 'escalation' && c) {
    if (c === 'maxRoundsBeforeHumanTriage') {
      const n = parseIntStrict(raw);
      // Schema requires minimum 1; silently keep the default for nonsense values.
      if (n >= 1) target.escalation.maxRoundsBeforeHumanTriage = n;
    } else if (c === 'triager') {
      target.escalation.triager = raw;
    }
    return;
  }
  if (a === 'spec' && b === 'bypassRequiresRole') {
    target.bypassRequiresRole = raw;
    return;
  }
}

function stripQuotes(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

function parseIntStrict(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return 0;
  return n;
}

/**
 * Validate cross-property invariants the JSON schema cannot express.
 * Surfaces a list of violations rather than throwing — callers decide
 * whether to abort or log + carry on with sane defaults.
 */
export function validateDorConfig(cfg: DorConfig): string[] {
  const violations: string[] = [];
  if (cfg.staleness.closeAfterDays <= cfg.staleness.warnAfterDays) {
    violations.push(
      `staleness.closeAfterDays (${cfg.staleness.closeAfterDays}) must be greater than staleness.warnAfterDays (${cfg.staleness.warnAfterDays})`,
    );
  }
  return violations;
}
