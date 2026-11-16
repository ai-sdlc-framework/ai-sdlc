/**
 * AISDLC-720 — producer of the untrusted-run signal.
 *
 * The PreToolUse hook (ai-sdlc-plugin/hooks) treats a session as untrusted only
 * when `AI_SDLC_UNTRUSTED_RUN` is set in ITS OWN process environment. For
 * agents spawned by the pipeline on outside input (the `gh-issue` source kind)
 * this module wraps the spawner so every spawned agent process inherits that
 * signal. The agent cannot clear it: env is fixed at spawn time.
 *
 * Spawners that do not launch a subprocess (the SDK spawner, MockSpawner)
 * ignore `SpawnOpts.env`; the signal only reaches the hook for subprocess
 * spawners such as `ShellClaudePSpawner`.
 */

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { SpawnOpts, SubagentResult, SubagentSpawner } from '../types.js';

export const UNTRUSTED_SPAWN_ENV: Readonly<Record<string, string>> = Object.freeze({
  AI_SDLC_UNTRUSTED_RUN: '1',
  AI_SDLC_UNTRUSTED_REASON: 'gh-issue source',
});

function markWith(reason: string): (o: SpawnOpts) => SpawnOpts {
  // The untrusted keys are applied LAST so a caller-supplied env cannot downgrade them.
  return (o) => ({
    ...o,
    env: { ...(o.env ?? {}), ...UNTRUSTED_SPAWN_ENV, AI_SDLC_UNTRUSTED_REASON: reason },
  });
}

/** Wrap a spawner so every spawn carries the untrusted-run signal. */
export function withUntrustedEnv(
  inner: SubagentSpawner,
  reason: string = UNTRUSTED_SPAWN_ENV.AI_SDLC_UNTRUSTED_REASON,
): SubagentSpawner {
  const mark = markWith(reason);
  return {
    spawn: (o: SpawnOpts): Promise<SubagentResult> => inner.spawn(mark(o)),
    spawnParallel: (os: SpawnOpts[]): Promise<SubagentResult[]> =>
      inner.spawnParallel(os.map(mark)),
  };
}

/**
 * AISDLC-730 — file marker that survives a child agent clearing its environment.
 * Lives in the worktree's git dir (never in the working tree, so it is never
 * committed). Mirrored by UNTRUSTED_MARKER_FILE in
 * ai-sdlc-plugin/hooks/lib/governance-resolver.js, which re-derives it by
 * walking up from the hook's cwd.
 */
export const UNTRUSTED_MARKER_FILE = 'ai-sdlc-untrusted';

/** Resolve the git dir of a checkout (`.git` dir, or the target of a `.git` gitdir file). */
function resolveGitDir(worktreePath: string): string | null {
  const dotGit = join(worktreePath, '.git');
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!m) return null;
  const target = m[1].trim();
  return isAbsolute(target) ? target : resolve(dirname(dotGit), target);
}

/**
 * Persist the untrusted marker for a worktree. Returns the marker path, or
 * null when the worktree has no resolvable git dir (the env signal still applies).
 */
export function writeUntrustedMarker(worktreePath: string, reason: string): string | null {
  const gitDir = resolveGitDir(worktreePath);
  if (!gitDir) return null;
  const file = join(gitDir, UNTRUSTED_MARKER_FILE);
  writeFileSync(file, `${reason}\n`, 'utf8');
  return file;
}

/**
 * AISDLC-730 — remove the untrusted marker. Called by the pipeline process (not
 * subject to the hook) when an untrusted run ends, and when a trusted run starts
 * in the same worktree, so a stale marker can never lock out a trusted session.
 * Returns true when a marker was removed, false when there was none (or no git dir).
 */
export function clearUntrustedMarker(worktreePath: string): boolean {
  const gitDir = resolveGitDir(worktreePath);
  if (!gitDir) return false;
  const file = join(gitDir, UNTRUSTED_MARKER_FILE);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * AISDLC-1277 — credential isolation for untrusted spawns.
 *
 * Parent env keys an untrusted agent may inherit. Everything else (GH_TOKEN,
 * ANTHROPIC_API_KEY, NPM_TOKEN, SSH_AUTH_SOCK, ...) is dropped. `HOME` is never
 * inherited: it is a throwaway directory created per run.
 */
export const UNTRUSTED_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'USER',
  'LOGNAME',
]);

/** Fixed keys the pipeline adds so git and gh find no credential. */
const UNTRUSTED_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
});

/** Tools an untrusted agent may use (no network or credential-bearing CLIs). */
export const UNTRUSTED_ALLOWED_TOOLS: readonly string[] = Object.freeze([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(pnpm test:*)',
  'Bash(pnpm build:*)',
  'Bash(pnpm lint:*)',
  'Bash(pnpm format:*)',
  'Bash(ls:*)',
]);

/** Non-bypass permission mode used for untrusted spawns. */
export const UNTRUSTED_PERMISSION_MODE = 'acceptEdits';

/** True when the spawn carries the untrusted-run signal. */
export function isUntrustedSpawnEnv(env: NodeJS.ProcessEnv | undefined): boolean {
  const v = env?.AI_SDLC_UNTRUSTED_RUN;
  return typeof v === 'string' && v !== '' && v !== '0';
}

/**
 * Build the child env for an untrusted spawn: allowlisted parent keys, the
 * caller's AI_SDLC_* signal keys, a throwaway HOME and the fixed no-credential keys.
 */
export function buildUntrustedChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  optsEnv: NodeJS.ProcessEnv | undefined,
  home: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of UNTRUSTED_ENV_ALLOWLIST) {
    if (parentEnv[k] !== undefined) out[k] = parentEnv[k];
  }
  for (const [k, v] of Object.entries(optsEnv ?? {})) {
    if (k.startsWith('AI_SDLC_') && v !== undefined) out[k] = v;
  }
  return { ...out, ...UNTRUSTED_FIXED_ENV, HOME: home };
}
