/**
 * RFC-0043 Phase 1 — Stage 1: Deterministic Diff / AST Gate (AISDLC-497)
 *
 * A pure-deterministic, LLM-free, runner-free gate that runs before any
 * expensive step in the UCVG pipeline. Consumes a unified diff or a list
 * of changed file paths and returns either `pass` or `abort-protected-path`.
 *
 * ## Boundary principle (OQ-6 resolution — codified here)
 *
 * Stage 1 patterns must satisfy BOTH:
 *   1. False-positive rate < 1%  — the pattern blocks a real attack, not
 *      legitimate contributor changes.
 *   2. Cheap-deterministic-value > downstream detection — the pattern is
 *      cheaper and more reliable than waiting for the LLM / sandbox to
 *      catch it.
 *
 * Sophisticated detection (entropy-based secret scanning, CVE correlation,
 * AST semantic analysis) delegates to RFC-0022 `secretScanStrictness` +
 * adopter-integrated SAST (Snyk / Semgrep / CodeQL / etc.).
 *
 * New heuristics are requested via `Decision: stage-1-content-heuristic-
 * addition-request` (RFC-0035 Stage A counter). They auto-promote at ≥2
 * distinct adopter requests AND false-positive criterion confirmed.
 *
 * ## Outcome semantics
 *
 * - `pass` — all mutations within `allowedMutationGlobs`; proceed to Stage 2.
 * - `abort-protected-path` — emit `UntrustedPrBlockedByProtectedPath` event,
 *   apply `needs-maintainer-review` label, post a comment naming offending
 *   paths, and STOP (no sandbox, no LLM cost).
 *
 * @module pipeline/ast-gate
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

export type AstGateOutcome = 'pass' | 'abort-protected-path';

export interface AstGateResult {
  outcome: AstGateOutcome;
  /** Paths that triggered the abort (empty on pass). */
  offendingPaths: string[];
  /** Content heuristic findings that triggered an abort (empty on pass). */
  heuristicFindings: HeuristicFinding[];
}

export interface HeuristicFinding {
  type: 'packageJsonLifecycleScript' | 'newGithubActionUses';
  path: string;
  detail: string;
}

/**
 * Content heuristic outcome options.
 * - `abort` — finding triggers abort-protected-path outcome
 * - `warn`  — finding is noted but does not abort (future use)
 */
export type HeuristicAction = 'abort' | 'warn';

/**
 * Adopter-configurable AST gate configuration.
 * Loaded from `.ai-sdlc/untrusted-pr-gate.yaml`.
 * These are the RFC-0043 §Stage 1 defaults.
 */
export interface AstGateConfig {
  /**
   * Paths that trigger `abort-protected-path` on mutation.
   *
   * RFC-0043 §Stage 1 defaults (deny wins):
   *   - `.github/**`                CI/CD config — RCE-via-workflow vector
   *   - `**\/.github/**`            nested .github dirs (e.g. packages/sub/.github/)
   *   - `**\/package.json`          lifecycle-script + dependency injection
   *   - `**\/pnpm-lock.yaml`        dependency lockfile in any workspace — supply-chain vector
   *   - `**\/package-lock.json`     dependency lockfile in any workspace — supply-chain vector
   *   - `**\/yarn.lock`             dependency lockfile in any workspace — supply-chain vector
   *   - `.ai-sdlc/**`               agent roles, gate config, attestation policy
   *   - `ai-sdlc-plugin/agents/**`  reviewer/dev prompt definitions
   *   - `**\/*.github/workflows/**` nested workflow configs
   */
  protectedPaths: string[];

  /**
   * Only these globs may change in an untrusted PR.
   * Deny wins: protected-path match takes priority over allowed-mutation match.
   *
   * RFC-0043 §Stage 1 defaults:
   *   - `**\/*.ts`, `**\/*.tsx`   TypeScript source
   *   - `**\/*.js`, `**\/*.jsx`   JavaScript source
   *   - `**\/*.md`                Documentation (low-risk)
   */
  allowedMutationGlobs: string[];

  /**
   * Content-based heuristics run on files that pass path checks.
   *
   * OQ-6 boundary principle: only patterns with <1% false-positive AND
   * cheap-deterministic-value over downstream LLM/sandbox detection.
   */
  contentHeuristics: {
    /**
     * Abort when `preinstall`, `postinstall`, or `prepare` lifecycle scripts
     * are added/modified in a `package.json` file.
     * Boundary: 0% false-positive (any lifecycle script in untrusted PR is
     * a concrete supply-chain attack vector), deterministic regex match.
     */
    packageJsonLifecycleScripts: HeuristicAction;

    /**
     * Abort when any new `uses:` reference appears in a GitHub Actions
     * workflow file that made it past path checks (edge case: non-standard
     * paths that somehow slip the glob).
     * Boundary: <0.1% false-positive (legitimate PRs don't add workflow
     * `uses:` in `.ts`/`.md` changes), deterministic regex match.
     */
    newGithubActionUses: HeuristicAction;
  };
}

// ── Defaults (RFC-0043 §Stage 1) ─────────────────────────────────────────────

/**
 * Default protected paths per RFC-0043 §Stage 1.
 * Deny wins — any match aborts immediately.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  '.github/**',
  '**/.github/**',
  '**/package.json',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '.ai-sdlc/**',
  'ai-sdlc-plugin/agents/**',
  '**/*.github/workflows/**',
] as const;

/**
 * Default allowed mutation globs per RFC-0043 §Stage 1.
 * Only files matching these globs may change in an untrusted PR.
 */
export const DEFAULT_ALLOWED_MUTATION_GLOBS: readonly string[] = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.md',
] as const;

/**
 * Default content heuristic config per RFC-0043 §Stage 1.
 */
export const DEFAULT_CONTENT_HEURISTICS: AstGateConfig['contentHeuristics'] = {
  packageJsonLifecycleScripts: 'abort',
  newGithubActionUses: 'abort',
} as const;

export const DEFAULT_AST_GATE_CONFIG: AstGateConfig = {
  protectedPaths: [...DEFAULT_PROTECTED_PATHS],
  allowedMutationGlobs: [...DEFAULT_ALLOWED_MUTATION_GLOBS],
  contentHeuristics: DEFAULT_CONTENT_HEURISTICS,
};

// ── Config loader ─────────────────────────────────────────────────────────────

/**
 * Load AST gate config from `.ai-sdlc/untrusted-pr-gate.yaml`.
 * Falls back to `DEFAULT_AST_GATE_CONFIG` when the file is absent.
 *
 * Adopter overrides are applied as a full replacement, not a merge,
 * so adopters who customize must declare the complete list.
 */
export function loadAstGateConfig(workDir: string = process.cwd()): AstGateConfig {
  const configPath = join(workDir, '.ai-sdlc', 'untrusted-pr-gate.yaml');
  if (!existsSync(configPath)) return DEFAULT_AST_GATE_CONFIG;

  const raw = readFileSync(configPath, 'utf8');
  const parsed = parseUntrustedPrGateYaml(raw);
  return mergeWithDefaults(parsed);
}

/**
 * Minimal hand-rolled parser for `.ai-sdlc/untrusted-pr-gate.yaml`.
 * Handles the Stage 1 section only (protectedPaths, allowedMutationGlobs,
 * contentHeuristics). Unknown keys are silently ignored (forward-compat).
 */
function parseUntrustedPrGateYaml(yaml: string): Partial<AstGateConfig> {
  // Use js-yaml via the module that is already in pipeline-cli's deps.
  // Since we cannot use dynamic require in pure ESM without top-level await,
  // we use a minimal extraction approach consistent with how dor-config.ts
  // handles this pattern (synchronous readFileSync + simple parse).
  //
  // The full js-yaml package is a pipeline-cli production dependency so we
  // import it below with a dynamic approach that stays synchronous.
  //
  // For robustness: if parse fails, fall back to defaults rather than throw.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml_lib = require('js-yaml') as typeof import('js-yaml');
    const doc = yaml_lib.load(yaml) as Record<string, unknown> | null;
    if (!doc || typeof doc !== 'object') return {};

    const result: Partial<AstGateConfig> = {};

    if (Array.isArray(doc['protectedPaths'])) {
      result.protectedPaths = (doc['protectedPaths'] as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      );
    }

    if (Array.isArray(doc['allowedMutationGlobs'])) {
      result.allowedMutationGlobs = (doc['allowedMutationGlobs'] as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      );
    }

    const ch = doc['contentHeuristics'];
    if (ch && typeof ch === 'object') {
      const chObj = ch as Record<string, unknown>;
      const packageJsonLifecycleScripts = chObj['packageJsonLifecycleScripts'];
      const newGithubActionUses = chObj['newGithubActionUses'];

      if (packageJsonLifecycleScripts === 'abort' || packageJsonLifecycleScripts === 'warn') {
        result.contentHeuristics = {
          ...DEFAULT_CONTENT_HEURISTICS,
          packageJsonLifecycleScripts,
        };
      }

      if (newGithubActionUses === 'abort' || newGithubActionUses === 'warn') {
        result.contentHeuristics = {
          ...(result.contentHeuristics ?? DEFAULT_CONTENT_HEURISTICS),
          newGithubActionUses,
        };
      }
    }

    return result;
  } catch {
    return {};
  }
}

function mergeWithDefaults(partial: Partial<AstGateConfig>): AstGateConfig {
  return {
    protectedPaths: partial.protectedPaths ?? [...DEFAULT_PROTECTED_PATHS],
    allowedMutationGlobs: partial.allowedMutationGlobs ?? [...DEFAULT_ALLOWED_MUTATION_GLOBS],
    contentHeuristics: partial.contentHeuristics ?? DEFAULT_CONTENT_HEURISTICS,
  };
}

// ── Path normalization ────────────────────────────────────────────────────────

/**
 * Normalize a file path before glob matching.
 *
 * Security invariant: ambiguous or adversarially-formed paths are DENIED
 * (treated as protected/blocked) rather than passed. This prevents attackers
 * from crafting paths that look safe but match unexpected locations.
 *
 * Normalization steps:
 *  1. Reject backslash separators (Windows-style paths are not valid in diffs
 *     produced by git on our supported platforms; any backslash is suspect).
 *  2. Unescape git core.quotePath octal/hex escapes in quoted paths
 *     (git wraps non-ASCII paths in double-quotes and encodes bytes as \\NNN
 *     or \\xNN — strip the surrounding quotes and unescape the sequences).
 *  3. Reject paths containing `../` segments (directory traversal).
 *  4. Strip a single leading `./` (canonical form).
 *  5. Strip a trailing `/` (file paths never end with /).
 *
 * Returns `null` when the path is ambiguous/unresolvable; callers MUST treat
 * null as "protected" (deny).
 */
export function normalizePath(rawPath: string): string | null {
  let path = rawPath;

  // Step 1: Unescape git core.quotePath quoted paths FIRST.
  // git wraps non-ASCII paths in double quotes and encodes bytes as \NNN (octal)
  // or \xNN (hex). Example: `"foo/b\303\251r.ts"` → `foo/bér.ts`.
  // We must handle this before the backslash-rejection step.
  // The octal sequences (\NNN) are raw UTF-8 bytes — we collect them as a
  // Uint8Array and decode via TextDecoder to produce correct Unicode strings.
  if (path.startsWith('"') && path.endsWith('"')) {
    const inner = path.slice(1, -1);
    try {
      // Two-pass approach:
      // Pass 1: split the inner string into segments of plain-ASCII chars and
      //         escape sequences (\NNN, \xNN, or other).
      // Pass 2: for runs of consecutive byte-valued escapes (\NNN / \xNN),
      //         collect into a Uint8Array and decode as UTF-8.
      const segments: Array<{ kind: 'ascii'; text: string } | { kind: 'byte'; value: number }> = [];
      let remaining = inner;
      while (remaining.length > 0) {
        const escIdx = remaining.indexOf('\\');
        if (escIdx === -1) {
          segments.push({ kind: 'ascii', text: remaining });
          break;
        }
        if (escIdx > 0) {
          segments.push({ kind: 'ascii', text: remaining.slice(0, escIdx) });
        }
        const afterSlash = remaining.slice(escIdx + 1);
        const octalMatch = afterSlash.match(/^([0-7]{3})/);
        const hexMatch = afterSlash.match(/^(x[0-9a-fA-F]{2})/);
        if (octalMatch) {
          segments.push({ kind: 'byte', value: parseInt(octalMatch[1], 8) });
          remaining = afterSlash.slice(3);
        } else if (hexMatch) {
          segments.push({ kind: 'byte', value: parseInt(hexMatch[1].slice(1), 16) });
          remaining = afterSlash.slice(3);
        } else {
          // Single-char escape: \n \t \" \\ etc.
          const escChar = afterSlash[0];
          const MAP: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' };
          segments.push({ kind: 'ascii', text: MAP[escChar] ?? escChar });
          remaining = afterSlash.slice(1);
        }
      }

      // Reconstruct string: decode consecutive byte segments as UTF-8
      let result = '';
      let i = 0;
      while (i < segments.length) {
        const seg = segments[i];
        if (seg.kind === 'ascii') {
          result += seg.text;
          i++;
        } else {
          // Collect a run of bytes for UTF-8 decoding
          const bytes: number[] = [];
          while (i < segments.length && segments[i].kind === 'byte') {
            bytes.push((segments[i] as { kind: 'byte'; value: number }).value);
            i++;
          }
          const uint8 = new Uint8Array(bytes);
          result += new TextDecoder('utf-8').decode(uint8);
        }
      }
      path = result;
    } catch {
      // Unescape failed — treat as ambiguous → deny
      return null;
    }
  } else if (rawPath.includes('\\')) {
    // Step 2: Reject bare backslash separators (Windows-style paths are not valid
    // in diffs produced by git on our supported platforms; any backslash is suspect).
    // Only applies to non-quoted paths — quoted paths have backslashes as escape prefix.
    return null;
  }

  // Step 3: Reject `../` directory traversal anywhere in the path
  if (path.includes('../') || path === '..' || path.startsWith('../')) return null;
  // Also reject encoded traversal that survived the unescape above
  if (/(^|\/)\.\.($|\/)/.test(path)) return null;

  // Step 4: Strip single leading `./`
  if (path.startsWith('./')) {
    path = path.slice(2);
  }

  // Step 5: Strip trailing `/`
  if (path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  // Reject empty path after normalization
  if (path.length === 0) return null;

  return path;
}

// ── Path matching helpers ──────────────────────────────────────────────────────

/**
 * Minimal glob matcher for Stage 1 protected-path / allowed-mutation checks.
 *
 * Supports:
 *   - `**` — matches any path segment including directory separators
 *   - `*`  — matches any segment within a single directory level
 *   - `?`  — matches a single character
 *   - `[...]` — character classes (pass-through to RegExp)
 *   - Exact string equality as the fallback
 *
 * This is intentionally minimal — it handles the RFC-0043 §Stage 1 default
 * patterns with 100% accuracy and does NOT attempt to replicate the full
 * POSIX glob specification. The patterns defined in `DEFAULT_PROTECTED_PATHS`
 * and `DEFAULT_ALLOWED_MUTATION_GLOBS` are the authoritative test cases.
 *
 * Keeps Stage 1 dependency-free (no minimatch/micromatch import).
 */
export function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      // `**` followed by `/` — anchored optional-prefix form so that the
      // directory separator boundary is respected.
      //
      // Example: `**/pnpm-lock.yaml` must match `packages/x/pnpm-lock.yaml`
      // but MUST NOT match `bad-pnpm-lock.yaml` (false-positive).
      //
      // Correct expansion: `(?:.*/)?` — "optionally any path prefix ending
      // with a `/`".  This keeps `**` from consuming into the next segment
      // without a separator boundary, fixing the false-positive class.
      //
      // `**` without a trailing `/` (e.g. at end of pattern like `dir/**`)
      // still expands to `.*` which matches any remaining characters.
      if (pattern[i + 2] === '/') {
        regexStr += '(?:.*/)?';
        i += 3; // skip `**/`
      } else {
        // `**` at end of pattern (e.g. `.github/**` → `.github/.*`)
        regexStr += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      // `*` matches anything except `/`
      regexStr += '[^/]*';
      i++;
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (ch === '[') {
      // Pass through character class
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        regexStr += '\\[';
        i++;
      } else {
        regexStr += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else if ('.+()^${}|\\'.includes(ch)) {
      // Escape special regex chars
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`);
}

/**
 * Returns true when `filePath` matches any glob in `patterns`.
 * Uses the minimal `globToRegex` matcher above.
 */
export function matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegex(pattern).test(filePath));
}

// ── Content heuristics ────────────────────────────────────────────────────────

/**
 * Lifecycle script keys that are abort-triggering per RFC-0043 §Stage 1.
 * These are the three script hooks that run automatically during `npm install`
 * / `pnpm install` and represent the highest-risk supply-chain attack surface.
 */
const LIFECYCLE_SCRIPT_KEYS = ['preinstall', 'postinstall', 'prepare'] as const;

/**
 * Check whether a `package.json` content diff adds/modifies lifecycle scripts.
 *
 * We compare the BEFORE and AFTER content of the file and look for
 * lifecycle script keys appearing in the AFTER version that were not
 * present (or had different values) in the BEFORE version.
 *
 * When `beforeContent` is null/undefined (new file), any lifecycle
 * scripts in `afterContent` are flagged.
 *
 * Boundary principle: false-positive rate ≈ 0% — any lifecycle script
 * in an untrusted PR is a concrete attack vector. Cheap deterministic.
 */
export function detectLifecycleScriptAdditions(
  afterContent: string,
  beforeContent?: string | null,
): string[] {
  let after: Record<string, unknown>;
  try {
    after = JSON.parse(afterContent) as Record<string, unknown>;
  } catch {
    // Not valid JSON — cannot inspect lifecycle scripts safely.
    // Conservative: no finding (malformed JSON fails for other reasons).
    return [];
  }

  const afterScripts = (after['scripts'] ?? {}) as Record<string, unknown>;

  let beforeScripts: Record<string, unknown> = {};
  if (beforeContent) {
    try {
      const before = JSON.parse(beforeContent) as Record<string, unknown>;
      beforeScripts = (before['scripts'] ?? {}) as Record<string, unknown>;
    } catch {
      // Before content unreadable — treat as if all after-scripts are new.
    }
  }

  const added: string[] = [];
  for (const key of LIFECYCLE_SCRIPT_KEYS) {
    const afterVal = afterScripts[key];
    const beforeVal = beforeScripts[key];
    if (afterVal !== undefined && afterVal !== beforeVal) {
      added.push(key);
    }
  }

  return added;
}

/**
 * Check whether a file content adds a NEW `uses:` line that was not present before.
 *
 * Applied as a belt-and-suspenders check for content that slipped past
 * protected-path globs (e.g. a `.ts` file embedding raw workflow YAML
 * in a template literal). In practice this fires rarely because the
 * `.github/**` protected-path glob catches workflow files directly.
 *
 * Uses LINE-LEVEL diff semantics: a line containing `uses:` that exists in
 * `afterContent` but NOT in `beforeContent` is treated as a newly-added line.
 * This prevents the bypass where a file already contains a benign `uses:` line
 * and an attacker hides a second malicious `uses: actions/evil@v1` line later —
 * the whole-file presence check would have passed, but the line-level check
 * catches the net-new line.
 *
 * Boundary: <0.1% false-positive — `uses:` in a `.ts` file is virtually
 * never a legitimate contributor change (it would be in a comment or
 * string, clearly suspicious in an untrusted PR).
 */
export function detectNewGithubActionUses(
  afterContent: string,
  beforeContent?: string | null,
): boolean {
  // Match lines containing `uses:` with optional leading whitespace / dash prefix.
  // Covers YAML workflow lines (`      - uses: actions/checkout@v4`) as well as
  // embedded YAML in .ts template literals.
  const USES_PATTERN = /\buses\s*:/;

  const afterLines = afterContent.split('\n');
  const usesInAfter = afterLines.filter((line) => USES_PATTERN.test(line));

  if (usesInAfter.length === 0) return false;

  if (beforeContent) {
    // Build a multiset of uses:-containing lines from the before content.
    const beforeLines = beforeContent.split('\n');
    const beforeUsesCounts = new Map<string, number>();
    for (const line of beforeLines) {
      if (USES_PATTERN.test(line)) {
        beforeUsesCounts.set(line, (beforeUsesCounts.get(line) ?? 0) + 1);
      }
    }

    // Check whether any uses:-line in after is a NET NEW addition:
    // if a line appears more times in after than in before, it was added.
    const afterUsesCounts = new Map<string, number>();
    for (const line of usesInAfter) {
      afterUsesCounts.set(line, (afterUsesCounts.get(line) ?? 0) + 1);
    }

    for (const [line, afterCount] of afterUsesCounts) {
      const beforeCount = beforeUsesCounts.get(line) ?? 0;
      if (afterCount > beforeCount) {
        // At least one net-new uses: line detected
        return true;
      }
    }

    return false;
  }

  // New file with `uses:` lines — flag it
  return true;
}

// ── File change input ─────────────────────────────────────────────────────────

/**
 * A single changed file in the PR diff.
 */
export interface ChangedFile {
  /** Repo-relative file path. */
  path: string;
  /** 'added' | 'modified' | 'deleted' | 'renamed' */
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /**
   * File content AFTER the change (for content heuristics).
   * Optional: if absent, content heuristics are skipped for this file.
   */
  afterContent?: string;
  /**
   * File content BEFORE the change (for content heuristics).
   * Optional: required to detect *additions* vs pre-existing scripts.
   */
  beforeContent?: string;
}

// ── Main gate function ────────────────────────────────────────────────────────

/**
 * Run the Stage 1 AST gate on a list of changed files.
 *
 * The gate applies in this order:
 *  1. Protected-path check (deny wins): any path matching `protectedPaths`
 *     → `abort-protected-path` immediately.
 *  2. Allowed-mutation check: any path NOT matching `allowedMutationGlobs`
 *     (and not caught by protected-path) → `abort-protected-path`.
 *  3. Content heuristics on files that passed (1) and (2).
 *
 * Returns `pass` only when ALL files are within `allowedMutationGlobs`
 * and no content heuristics fire.
 *
 * Per RFC-0043 §Stage 1: deny wins.
 */
export function runAstGate(
  changedFiles: ChangedFile[],
  config: AstGateConfig = DEFAULT_AST_GATE_CONFIG,
): AstGateResult {
  const offendingPaths: string[] = [];
  const heuristicFindings: HeuristicFinding[] = [];

  for (const file of changedFiles) {
    // Step 0: Normalize the path — ambiguous/unresolvable paths are DENIED
    const normalizedPath = normalizePath(file.path);
    if (normalizedPath === null) {
      offendingPaths.push(file.path);
      continue;
    }

    // Step 1: Protected-path check (deny wins)
    if (matchesAnyGlob(normalizedPath, config.protectedPaths)) {
      offendingPaths.push(file.path);
      // Continue to collect ALL offending paths (don't abort early)
      continue;
    }

    // Step 2: Allowed-mutation check
    if (!matchesAnyGlob(normalizedPath, config.allowedMutationGlobs)) {
      offendingPaths.push(file.path);
      continue;
    }

    // Step 3: Content heuristics (only for files that passed path checks)
    if (file.afterContent !== undefined) {
      // 3a: package.json lifecycle scripts
      if (
        normalizedPath.endsWith('package.json') &&
        config.contentHeuristics.packageJsonLifecycleScripts === 'abort'
      ) {
        const addedScripts = detectLifecycleScriptAdditions(file.afterContent, file.beforeContent);
        if (addedScripts.length > 0) {
          heuristicFindings.push({
            type: 'packageJsonLifecycleScript',
            path: file.path,
            detail: `lifecycle scripts added/modified: ${addedScripts.join(', ')}`,
          });
        }
      }

      // 3b: New GitHub Action `uses:` references
      if (config.contentHeuristics.newGithubActionUses === 'abort') {
        if (detectNewGithubActionUses(file.afterContent, file.beforeContent)) {
          heuristicFindings.push({
            type: 'newGithubActionUses',
            path: file.path,
            detail: 'new `uses:` reference detected in file content',
          });
        }
      }
    }
  }

  const hasViolations = offendingPaths.length > 0 || heuristicFindings.length > 0;

  if (!hasViolations) {
    return { outcome: 'pass', offendingPaths: [], heuristicFindings: [] };
  }

  return {
    outcome: 'abort-protected-path',
    offendingPaths,
    heuristicFindings,
  };
}

// ── Abort action helpers ──────────────────────────────────────────────────────

/**
 * Event type emitted when an untrusted PR is blocked by the protected-path gate.
 * Per RFC-0043 §Stage 1 AC#8 (AISDLC-497).
 */
export interface UntrustedPrBlockedByProtectedPathEvent {
  type: 'UntrustedPrBlockedByProtectedPath';
  ts: string;
  prNumber: number;
  author: string;
  offendingPaths: string[];
  heuristicFindings: HeuristicFinding[];
  /** The label applied to the PR. */
  label: 'needs-maintainer-review';
}

/**
 * Build the `UntrustedPrBlockedByProtectedPath` event for event-log emission.
 * Callers are responsible for writing to `.ai-sdlc/enforcement/*.jsonl`.
 */
export function buildBlockedEvent(
  prNumber: number,
  author: string,
  gateResult: AstGateResult,
  now: Date = new Date(),
): UntrustedPrBlockedByProtectedPathEvent {
  return {
    type: 'UntrustedPrBlockedByProtectedPath',
    ts: now.toISOString(),
    prNumber,
    author,
    offendingPaths: gateResult.offendingPaths,
    heuristicFindings: gateResult.heuristicFindings,
    label: 'needs-maintainer-review',
  };
}

/**
 * Build the GitHub comment body naming offending paths.
 * Posted to the PR when the gate aborts (AC#8).
 *
 * Note: does NOT include internal tracker IDs (AISDLC-NNN) per the
 * adopter-facing-strings gate (AISDLC-394).
 */
export function buildBlockedComment(gateResult: AstGateResult, author: string): string {
  const lines: string[] = [
    '## Protected-path gate blocked this PR',
    '',
    `@${author} — this PR modifies files that require maintainer review.`,
    '',
  ];

  if (gateResult.offendingPaths.length > 0) {
    lines.push(
      'The following paths are protected and may not be changed by untrusted contributors:',
    );
    lines.push('');
    for (const path of gateResult.offendingPaths) {
      lines.push(`- \`${path}\``);
    }
  }

  if (gateResult.heuristicFindings.length > 0) {
    lines.push('', 'The following content heuristics also triggered:');
    for (const finding of gateResult.heuristicFindings) {
      lines.push(`- \`${finding.path}\`: ${finding.detail}`);
    }
  }

  lines.push(
    '',
    'This PR has been labeled `needs-maintainer-review`. A maintainer will',
    'review this PR before any automated processing proceeds.',
    '',
    'If you believe this change is legitimate, please open a discussion',
    'with the maintainers.',
  );

  return lines.join('\n');
}

// ── Stage A counter (Decision Catalog) ────────────────────────────────────────

/**
 * Decision summary for `stage-1-content-heuristic-addition-request`.
 *
 * This counter (RFC-0035 Stage A, AC#7) increments each time an adopter
 * requests a new Stage 1 content heuristic. Auto-promotes at ≥2 distinct
 * adopter requests for the same pattern AND the false-positive criterion
 * is confirmed. No v1 activation surface — counter only.
 *
 * Callers use this constant to open a Decision via `cli-decisions add`.
 *
 * The string value MUST NOT contain internal tracker IDs per AISDLC-394.
 */
export const STAGE_1_HEURISTIC_REQUEST_DECISION_SUMMARY =
  'stage-1-content-heuristic-addition-request';

/**
 * RFC-0035 Stage A counter entry shape for the heuristic-request Decision.
 * Emitted to `.ai-sdlc/_decisions/events.jsonl` by the drift workflow
 * when adopters submit heuristic requests.
 *
 * Counter semantics: auto-promote when counter.count >= 2 AND
 * false-positive rate confirmed < 1% (operator-validated).
 * No activation surface in Phase 1 — counter tracking only.
 */
export interface HeuristicAdditionRequestCounter {
  /** Name of the requested heuristic pattern. */
  pattern: string;
  /** Count of distinct adopter requests for this pattern. */
  count: number;
  /** False-positive rate if evaluated, else null. */
  falsePositiveRate: number | null;
  /** Whether the pattern has been promoted to RFC amendment. */
  promoted: boolean;
}
