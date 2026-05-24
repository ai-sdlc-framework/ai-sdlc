/**
 * `.ai-sdlc/adopter-authoring.yaml` reader — `import.*` slice only.
 *
 * RFC-0036 §14.1 codifies the per-org schema. Phase 4 (AISDLC-329)
 * consumes the `import:` keys; later phases (5 + 6) consume drift /
 * speckit-bridge / cross-tool keys.
 *
 * Intentional scope: this is a thin reader. Missing files / missing
 * keys fall back to the §14.1 defaults so a freshly bootstrapped repo
 * runs `cli-import-spec` against the v1 contract with zero config.
 *
 * @module import-spec/config
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export type ArtifactGranularity = 'tasks-md-only';
export type DorStrictness = 'strict' | 'warn';
export type DorRejection = 'refuse-emit-clarification';

export interface ImportConfig {
  /** OQ-1 — tasks.md only (no fallback). */
  artifactGranularity: ArtifactGranularity;
  /**
   * OQ-3 — strict by default. Phase 5 wires the actual DoR run; Phase 4
   * already records the value so the eventual switch is a single line.
   */
  dorStrictness: DorStrictness;
  /** OQ-10 — refuse-and-emit on rejection. Phase 5 honours this. */
  dorRejection: DorRejection;
}

export interface AdopterAuthoringConfig {
  import: ImportConfig;
}

const DEFAULTS: AdopterAuthoringConfig = {
  import: {
    artifactGranularity: 'tasks-md-only',
    dorStrictness: 'strict',
    dorRejection: 'refuse-emit-clarification',
  },
};

export interface LoadAdopterAuthoringOpts {
  workDir?: string;
  /** Override the resolved file path entirely (tests). */
  filePath?: string;
}

/**
 * Resolve `<workDir>/.ai-sdlc/adopter-authoring.yaml`. Pure function — does
 * not check existence.
 */
export function resolveAdopterAuthoringPath(workDir: string = process.cwd()): string {
  return join(workDir, '.ai-sdlc', 'adopter-authoring.yaml');
}

/**
 * Load + validate the `adopter-authoring.yaml` import slice. Missing file
 * or missing keys fall back to §14.1 defaults. Malformed YAML throws —
 * silent fall-through on a corrupted config would mask operator error.
 */
export function loadAdopterAuthoringConfig(
  opts: LoadAdopterAuthoringOpts = {},
): AdopterAuthoringConfig {
  const path = opts.filePath ?? resolveAdopterAuthoringPath(opts.workDir);
  if (!existsSync(path)) return cloneDefaults();

  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(path, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[adopter-authoring] failed to parse ${path}: ${msg}`);
  }

  if (raw === null || typeof raw !== 'object') return cloneDefaults();

  const root = raw as Record<string, unknown>;
  // The schema nests under `adopter-authoring:` per RFC §14.1; accept both
  // the nested form and a flat top-level form so tests + simple adopter
  // setups don't need the extra indent.
  const nested = root['adopter-authoring'];
  const source = (nested && typeof nested === 'object' ? nested : root) as Record<string, unknown>;

  const importSlice = source.import;
  if (!importSlice || typeof importSlice !== 'object') return cloneDefaults();

  return {
    import: mergeImport(importSlice as Record<string, unknown>),
  };
}

function cloneDefaults(): AdopterAuthoringConfig {
  return { import: { ...DEFAULTS.import } };
}

function mergeImport(slice: Record<string, unknown>): ImportConfig {
  const artifact = slice.artifactGranularity;
  const strictness = slice.dorStrictness;
  const rejection = slice.dorRejection;
  return {
    artifactGranularity:
      artifact === 'tasks-md-only' ? 'tasks-md-only' : DEFAULTS.import.artifactGranularity,
    dorStrictness:
      strictness === 'strict' || strictness === 'warn'
        ? (strictness as DorStrictness)
        : DEFAULTS.import.dorStrictness,
    dorRejection:
      rejection === 'refuse-emit-clarification'
        ? 'refuse-emit-clarification'
        : DEFAULTS.import.dorRejection,
  };
}
