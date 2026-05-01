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

export interface DorConfig {
  rubricVersion: 'v1';
  evaluationMode: DorEvaluationMode;
  notifications: DorConfigNotifications;
  staleness: DorConfigStaleness;
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
 *     `spec.staleness.warnAfterDays/closeAfterDays/closedLabel`.
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

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const line = rawLine.trim();
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1).trim();
    const path = stack.map((s) => s.key);

    if (!valueRaw) {
      stack.push({ indent, key });
      continue;
    }

    applyValue(out, [...path, key], stripQuotes(valueRaw));
  }
  return out;
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
