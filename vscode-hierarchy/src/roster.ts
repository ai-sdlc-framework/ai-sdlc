/** Roster reading and `cli-hierarchy.mjs` resolution, with the filesystem injected. */

import path from 'node:path';

/** Relative location of the roster inside a repository. */
export const ROSTER_RELATIVE = path.join('.ai-sdlc', 'dispatch', 'hierarchy.json');

/** Relative location of the bin inside a repository. */
export const REPO_BIN_RELATIVE = path.join('pipeline-cli', 'bin', 'cli-hierarchy.mjs');

/** Filesystem slice used here. */
export interface RosterFs {
  exists(p: string): boolean;
  /** Names of the subdirectories of `dir`; empty when unreadable. */
  subdirs(dir: string): string[];
}

/**
 * Agent names (tmux windows) in a roster document. A missing or unparseable document yields
 * `undefined` (a half-written file must not close the terminals); entries without a usable
 * `tmuxWindow` are skipped.
 */
export function parseRosterNames(text: string): string[] | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const sessions = (doc as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return undefined;
  const names: string[] = [];
  for (const s of sessions) {
    const w = (s as { tmuxWindow?: unknown } | null)?.tmuxWindow;
    if (typeof w === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(w) && !names.includes(w)) {
      names.push(w);
    }
  }
  return names;
}

/** Roster files for these workspace folders: in the folder itself or one level below. */
export function findRosterFiles(folders: readonly string[], fs: RosterFs): string[] {
  const found: string[] = [];
  for (const folder of folders) {
    const direct = path.join(folder, ROSTER_RELATIVE);
    if (fs.exists(direct)) found.push(direct);
    for (const sub of fs.subdirs(folder)) {
      const nested = path.join(folder, sub, ROSTER_RELATIVE);
      if (fs.exists(nested)) found.push(nested);
    }
  }
  return found;
}

/** Repository root owning a roster file (`<root>/.ai-sdlc/dispatch/hierarchy.json`). */
export function repoRootOf(rosterFile: string): string {
  return path.dirname(path.dirname(path.dirname(rosterFile)));
}

function versionKey(v: string): number[] {
  return v.split('.').map((p) => Number.parseInt(p, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Absolute path of `cli-hierarchy.mjs`, same rule as the plugin resolver
 * (`resolve-pipeline-cli.sh`): the repository's own `pipeline-cli/bin` first, then the
 * highest installed Claude plugin cache version, then the `pipelineCliBin` setting.
 */
export function resolveHierarchyBin(args: {
  repoRoot: string;
  homeDir: string;
  setting: string;
  fs: RosterFs;
}): string | undefined {
  const { repoRoot, homeDir, setting, fs } = args;
  const inRepo = path.join(repoRoot, REPO_BIN_RELATIVE);
  if (fs.exists(inRepo)) return inRepo;

  const cacheRoot = path.join(homeDir, '.claude', 'plugins', 'cache');
  const cached: { version: string; bin: string }[] = [];
  for (const marketplace of fs.subdirs(cacheRoot)) {
    const pluginDir = path.join(cacheRoot, marketplace, 'ai-sdlc');
    for (const version of fs.subdirs(pluginDir)) {
      const bin = path.join(
        pluginDir,
        version,
        'node_modules',
        '@ai-sdlc',
        'pipeline-cli',
        'bin',
        'cli-hierarchy.mjs',
      );
      if (fs.exists(bin)) cached.push({ version, bin });
    }
  }
  cached.sort((a, b) => compareVersions(b.version, a.version));
  if (cached[0]) return cached[0].bin;

  return setting.trim() !== '' && fs.exists(setting.trim()) ? setting.trim() : undefined;
}
