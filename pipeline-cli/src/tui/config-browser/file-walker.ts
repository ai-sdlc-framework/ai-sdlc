/**
 * Config-browser file walker — RFC-0023 §9 / AISDLC-178.5 AC#4.
 *
 * Lists every YAML file under `.ai-sdlc/`, returning a stable
 * lexicographic order so the operator's eye-line reading is consistent
 * across renders.
 *
 * Subdirectories (e.g. `.ai-sdlc/schemas/`, `.ai-sdlc/attestations/`) are
 * NOT recursed — they hold derivative artifacts (schemas, signed
 * envelopes), not human-edited config. Only the top-level `*.yaml` /
 * `*.yml` files surface.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SourceErrorKind } from '../sources/types.js';
import { classifyFsError } from '../sources/types.js';

export interface ConfigFile {
  /** Display name (basename only, e.g. `pipeline.yaml`). */
  name: string;
  /** Absolute path. */
  absPath: string;
  /** Relative-to-workdir path (e.g. `.ai-sdlc/pipeline.yaml`). */
  relPath: string;
}

export interface ListConfigFilesOpts {
  /** Project root. Defaults `process.cwd()`. */
  workDir?: string;
  /** Inject readdir (tests). Defaults to `node:fs.readdirSync`. */
  readdir?: (path: string) => string[];
  /** Inject statSync (tests). Defaults to `node:fs.statSync`. */
  stat?: (path: string) => { isFile: () => boolean };
}

export interface ListConfigFilesResult {
  files: ConfigFile[];
  error: SourceErrorKind | null;
}

/**
 * Pure file walker — exported so unit tests can drive without a real fs.
 *
 * Returns `{ files: [], error: 'source-unavailable' }` when `.ai-sdlc/`
 * doesn't exist. Other fs errors classify via the shared helper.
 */
export function listConfigFiles(opts: ListConfigFilesOpts = {}): ListConfigFilesResult {
  const workDir = opts.workDir ?? process.cwd();
  const dir = join(workDir, '.ai-sdlc');
  const readdir = opts.readdir ?? ((p): string[] => readdirSync(p));
  const stat = opts.stat ?? ((p): { isFile: () => boolean } => statSync(p));

  let entries: string[];
  try {
    entries = readdir(dir);
  } catch (err) {
    return { files: [], error: classifyFsError(err) };
  }

  const files: ConfigFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const abs = join(dir, entry);
    try {
      if (!stat(abs).isFile()) continue;
    } catch {
      continue;
    }
    files.push({
      name: entry,
      absPath: abs,
      relPath: join('.ai-sdlc', entry),
    });
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, error: null };
}

export interface ReadConfigFileOpts {
  absPath: string;
  reader?: (path: string) => string;
}

export interface ReadConfigFileResult {
  text: string | null;
  error: SourceErrorKind | null;
}

/**
 * Read a single config file's body.
 */
export function readConfigFile(opts: ReadConfigFileOpts): ReadConfigFileResult {
  const reader = opts.reader ?? ((p: string): string => readFileSync(p, 'utf8'));
  try {
    return { text: reader(opts.absPath), error: null };
  } catch (err) {
    return { text: null, error: classifyFsError(err) };
  }
}
