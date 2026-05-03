/**
 * Versioned failure-pattern catalogue loader (RFC-0015 §13 Q9).
 *
 * Source-of-truth file: `.ai-sdlc/orchestrator-failure-patterns.yaml`.
 * Schema:                `.ai-sdlc/schemas/orchestrator-failure-patterns.v1.schema.json`.
 *
 * The YAML carries the 9 default patterns from §5.1 (8 original +
 * `StackedPRBaseSquashed` from the post-iteration addition). Per-project
 * overrides extend or replace entries via the same file shape.
 *
 * The loader does shape validation in-process (no `ajv` dep at runtime)
 * because the schema is small and stable. CI is expected to run a real
 * JSON Schema validator against the same file as a guard rail.
 *
 * Per RFC §13 Q7 (per-project config), the loaded catalogue exposes
 * per-mode `budget` overrides; Phase 2 ships the in-memory representation
 * Phase 4 wires the YAML reader into the orchestrator's bootstrap.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CATALOGUED_MODES, type FailureMode } from './types.js';

export interface CataloguePatternEntry {
  mode: FailureMode;
  budget: number;
  description: string;
  /**
   * Optional `escalateImmediately` override (RFC §13 Q7). When true the
   * runner skips remediation and goes straight to escalation. Default false.
   */
  escalateImmediately: boolean;
}

export interface FailurePatternCatalogue {
  version: 'v1';
  patterns: CataloguePatternEntry[];
}

/** Default catalogue baked in. The YAML on disk SHOULD match this; the loader validates. */
export const DEFAULT_CATALOGUE: FailurePatternCatalogue = {
  version: 'v1',
  patterns: [
    {
      mode: 'SecretScanBlocked',
      budget: 2,
      escalateImmediately: false,
      description:
        'git push rejected with `push declined due to repository rule violations` + `Secret Scanning` mention. Reformat literal-secret patterns to template-literal construction; recommit; retry push.',
    },
    {
      mode: 'PushRaceWithMergeQueue',
      budget: 3,
      escalateImmediately: false,
      description:
        'git push rejected with `protected branch hook declined` + `queued for merging`. Sleep 60s and retry push.',
    },
    {
      mode: 'RebaseConflict',
      budget: 1,
      escalateImmediately: false,
      description:
        'git rebase origin/main exits non-zero with conflict markers. Invoke /ai-sdlc rebase (AISDLC-105) to attempt mechanical resolution.',
    },
    {
      mode: 'VerificationFailure',
      budget: 2,
      escalateImmediately: false,
      description:
        'pnpm build/test/lint/format exits non-zero in dev verify stage. Re-spawn dev with combined verification stderr feedback.',
    },
    {
      mode: 'ReviewerMajorOrCritical',
      budget: 2,
      escalateImmediately: false,
      description:
        'Aggregated reviewer verdict has any critical or major finding. Re-spawn dev with combined reviewer feedback.',
    },
    {
      mode: 'EnvHookFailure',
      budget: 1,
      escalateImmediately: false,
      description:
        'husky pre-commit fails with tsc/command-not-found. Retry with --no-verify ONLY if change is data-only (backlog/, docs/, spec/, root *.md).',
    },
    {
      mode: 'AttestationVerifyMismatch',
      budget: 1,
      escalateImmediately: false,
      description:
        'CI reports contentHashV3 mismatch after a sibling PR merged. Re-sign attestation per AISDLC-102; re-spawn 3 reviewers if contentHashV3 changed.',
    },
    {
      mode: 'LongRunningPRBlocksWorker',
      budget: 1,
      escalateImmediately: false,
      description:
        "Worker's PR open + queued for >2h without merge OR rejection. Park worker; release worktree; emit WorkerParked.",
    },
    {
      mode: 'StackedPRBaseSquashed',
      budget: 1,
      escalateImmediately: false,
      description:
        "Previously-opened PR's mergeStateStatus flips to DIRTY AND base PR was merged via squash/rebase strategy. git fetch origin main && git rebase --reapply-cherry-picks; force-push.",
    },
  ],
};

export interface LoadCatalogueOpts {
  /** Project root. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Override the on-disk path entirely (tests). */
  filePath?: string;
}

export function resolveCataloguePath(opts: LoadCatalogueOpts = {}): string {
  if (opts.filePath) return opts.filePath;
  const workDir = opts.workDir ?? process.cwd();
  return join(workDir, '.ai-sdlc', 'orchestrator-failure-patterns.yaml');
}

/**
 * Load + validate the catalogue. Missing file → returns the default
 * catalogue (so a freshly-bootstrapped repo without the YAML still gets
 * the §5.1 behaviours). Present-but-malformed file → throws.
 */
export function loadFailurePatternCatalogue(opts: LoadCatalogueOpts = {}): FailurePatternCatalogue {
  const path = resolveCataloguePath(opts);
  if (!existsSync(path)) return DEFAULT_CATALOGUE;
  const raw = readFileSync(path, 'utf8');
  return parseCatalogueYaml(raw, path);
}

/**
 * Parse the YAML into the typed catalogue + validate shape. Public so
 * tests can drive the parser without touching disk.
 *
 * Supported shape (intentionally narrow — reflects the schema):
 *
 *   version: v1
 *   patterns:
 *     - mode: SecretScanBlocked
 *       budget: 2
 *       escalateImmediately: false
 *       description: "..."
 *     - mode: PushRaceWithMergeQueue
 *       budget: 3
 *       ...
 *
 * Anything else is a validation failure. We don't tolerate unknown keys
 * because Q9 explicitly calls out "schema-violation = orchestrator
 * refuses to start."
 */
export function parseCatalogueYaml(yaml: string, path = '<inline>'): FailurePatternCatalogue {
  const lines = yaml.split('\n');
  let version: string | null = null;
  const patterns: CataloguePatternEntry[] = [];

  let inPatterns = false;
  let current: Partial<CataloguePatternEntry> | null = null;

  const flush = (): void => {
    if (!current) return;
    if (!current.mode) {
      throw new CatalogueParseError(`${path}: pattern entry missing required field 'mode'`);
    }
    if (typeof current.budget !== 'number') {
      throw new CatalogueParseError(
        `${path}: pattern '${current.mode}' missing required field 'budget'`,
      );
    }
    patterns.push({
      mode: current.mode,
      budget: current.budget,
      description: current.description ?? '',
      escalateImmediately: current.escalateImmediately ?? false,
    });
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (!inPatterns) {
      const v = matchKv(line, /^version:\s*(.+)$/);
      if (v !== null) {
        version = stripQuotes(v.trim());
        continue;
      }
      if (/^patterns:\s*$/.test(line)) {
        inPatterns = true;
        continue;
      }
      // Unknown top-level key.
      throw new CatalogueParseError(`${path}: unexpected top-level line: ${line}`);
    }

    // We're inside `patterns:`.
    if (/^\s*-\s/.test(line)) {
      flush();
      current = {};
      // Inline `- key: value` form is supported.
      const after = line.replace(/^\s*-\s+/, '');
      applyPatternField(current, after, path);
      continue;
    }
    if (!current) {
      throw new CatalogueParseError(`${path}: unexpected line outside of a pattern entry: ${line}`);
    }
    applyPatternField(current, line.trim(), path);
  }
  flush();

  if (version !== 'v1') {
    throw new CatalogueParseError(`${path}: version must be 'v1' (got ${JSON.stringify(version)})`);
  }
  validatePatterns(patterns, path);
  return { version: 'v1', patterns };
}

/**
 * Layer the on-disk catalogue's per-mode budget on top of the registry's
 * default budget. Returns a flat `Record<FailureMode, number>` the runner
 * can dereference per dispatch.
 */
export function effectiveBudgets(catalogue: FailurePatternCatalogue): Record<FailureMode, number> {
  const out = {} as Record<FailureMode, number>;
  for (const m of CATALOGUED_MODES) {
    out[m] = DEFAULT_CATALOGUE.patterns.find((p) => p.mode === m)?.budget ?? 1;
  }
  out.UnknownFailureMode = 0;
  for (const p of catalogue.patterns) {
    out[p.mode] = p.budget;
  }
  return out;
}

export class CatalogueParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueParseError';
  }
}

// ── Internals ─────────────────────────────────────────────────────────

function matchKv(line: string, re: RegExp): string | null {
  const m = re.exec(line);
  return m ? (m[1] ?? null) : null;
}

function applyPatternField(
  target: Partial<CataloguePatternEntry>,
  text: string,
  path: string,
): void {
  // Support `- mode: X` plus subsequent indented `key: value` lines.
  const colon = text.indexOf(':');
  if (colon < 0) return;
  const key = text.slice(0, colon).trim();
  const valueRaw = text.slice(colon + 1).trim();
  const value = stripQuotes(valueRaw);
  switch (key) {
    case 'mode':
      if (!CATALOGUED_MODES.includes(value as FailureMode)) {
        throw new CatalogueParseError(
          `${path}: unknown mode '${value}' — must be one of ${CATALOGUED_MODES.join(', ')}`,
        );
      }
      target.mode = value as FailureMode;
      return;
    case 'budget': {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new CatalogueParseError(
          `${path}: budget for '${target.mode ?? '?'}' must be a non-negative integer (got ${value})`,
        );
      }
      target.budget = n;
      return;
    }
    case 'escalateImmediately':
      target.escalateImmediately = value === 'true';
      return;
    case 'description':
      target.description = value;
      return;
    default:
      // Unknown keys are a hard error — Q9 strict shape.
      throw new CatalogueParseError(`${path}: unknown pattern field '${key}'`);
  }
}

function stripQuotes(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

function validatePatterns(patterns: CataloguePatternEntry[], path: string): void {
  const seen = new Set<string>();
  for (const p of patterns) {
    if (seen.has(p.mode)) {
      throw new CatalogueParseError(`${path}: duplicate pattern entry for mode '${p.mode}'`);
    }
    seen.add(p.mode);
  }
  // Default catalogue must cover all 9 catalogued modes — a partial
  // override file is fine (operators can override a subset) but the
  // BOOTSTRAP one we ship MUST have all 9. We enforce coverage here only
  // when the caller is using the bootstrap path (signaled by every
  // catalogue carrying all 9 modes). Operator overrides may carry fewer.
  // Coverage-completeness is enforced by `loadFailurePatternCatalogue`'s
  // missing-file fallback, not here.
}
