import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { validate } from '../core/validation.js';

export const CAPABILITIES_CONFIG_PATH = '.ai-sdlc/capabilities.yaml';

export interface LoadCapabilitiesConfigOpts {
  /** Repository root (git repo / worktree). Defaults to `process.cwd()`. */
  workDir?: string;
  /** Base ref the trusted config is read from. Defaults to `origin/main`. */
  baseRef?: string;
  /** Base-ref reader (test injection). Must return null, never throw, on failure. */
  readBaseConfig?: (workDir: string, baseRef: string) => string | null;
}

/**
 * Read the file AS COMMITTED on `baseRef` via `git show`, never the working tree: a
 * pull request must not be able to relax the declaration it is governed by.
 * Returns null on any failure.
 */
export function readCapabilitiesConfigFromBaseRef(workDir: string, baseRef: string): string | null {
  if (!baseRef || baseRef.startsWith('-')) return null;
  try {
    return execFileSync('git', ['show', `${baseRef}:${CAPABILITIES_CONFIG_PATH}`], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * The capability ids this repository requires to be live, read from the base ref.
 * A missing, unreadable or schema-invalid file resolves to an empty list. Never throws.
 */
export function loadRequiredCapabilities(opts: LoadCapabilitiesConfigOpts = {}): string[] {
  try {
    const read = opts.readBaseConfig ?? readCapabilitiesConfigFromBaseRef;
    const raw = read(opts.workDir ?? process.cwd(), opts.baseRef ?? 'origin/main');
    if (!raw) return [];
    const doc = parseYaml(raw);
    if (!validate('CapabilitiesConfig', doc).valid) return [];
    const required = (doc as { spec: { required?: string[] } }).spec.required;
    return Array.isArray(required) ? [...required] : [];
  } catch {
    return [];
  }
}
