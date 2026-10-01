import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validate } from '../core/validation.js';
import {
  disabledJudgmentConfig,
  resolveJudgmentConfig,
  type ResolvedJudgmentConfig,
} from './config.js';

export const JUDGMENT_CONFIG_PATH = '.ai-sdlc/judgment-config.yaml';

export interface LoadJudgmentConfigOpts {
  /** Repository root (git repo / worktree). Defaults to `process.cwd()`. */
  workDir?: string;
  /** Base ref the trusted config is read from. Defaults to `origin/main`. */
  baseRef?: string;
  /** Environment override for tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Base-ref reader (test injection). Must return null, never throw, on failure. */
  readBaseConfig?: (workDir: string, baseRef: string) => string | null;
  /** Local-file reader for the operator-controlled env path (test injection). */
  readLocalFile?: (path: string) => string | null;
}

/**
 * Read the config AS COMMITTED on `baseRef` via `git show`, never the working
 * tree: a pull request must not be able to relax the configuration it is
 * governed by. Returns null on any failure.
 */
export function readJudgmentConfigFromBaseRef(workDir: string, baseRef: string): string | null {
  if (!baseRef || baseRef.startsWith('-')) return null;
  try {
    return execFileSync('git', ['show', `${baseRef}:${JUDGMENT_CONFIG_PATH}`], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function readLocalFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve the judgment config. Precedence:
 *   1. `AI_SDLC_JUDGMENT=off` disables the layer.
 *   2. `AI_SDLC_JUDGMENT_CONFIG_PATH` (operator-controlled) names a local file.
 *   3. `.ai-sdlc/judgment-config.yaml` on the base ref (default `origin/main`).
 * A missing, unreadable or schema-invalid file resolves to the disabled config.
 * Never throws.
 */
export function loadJudgmentConfig(opts: LoadJudgmentConfigOpts = {}): ResolvedJudgmentConfig {
  try {
    const env = opts.env ?? process.env;
    if (env.AI_SDLC_JUDGMENT === 'off') return disabledJudgmentConfig();

    const envPath = env.AI_SDLC_JUDGMENT_CONFIG_PATH;
    let raw: string | null;
    if (envPath) {
      raw = (opts.readLocalFile ?? readLocalFileSafe)(envPath);
    } else {
      const read = opts.readBaseConfig ?? readJudgmentConfigFromBaseRef;
      raw = read(opts.workDir ?? process.cwd(), opts.baseRef ?? 'origin/main');
    }
    if (!raw) return disabledJudgmentConfig();

    const doc = parseYaml(raw);
    const result = validate('JudgmentConfig', doc);
    if (!result.valid) return disabledJudgmentConfig();
    return resolveJudgmentConfig(doc);
  } catch {
    return disabledJudgmentConfig();
  }
}
