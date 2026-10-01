/**
 * Sandbox for the reviewer replay session (RFC-0050 B4).
 *
 * The replay runs a model over a historical commit that was picked because it
 * carried a defect. The session must therefore be unable to act on anything
 * that commit contains: no shell, no writes, no network tools, no MCP servers,
 * no project settings or hooks, and no `bypassPermissions`. When the installed
 * `claude` lacks any flag this relies on, the replay refuses to run; it never
 * falls back to a weaker mode.
 *
 * @module usage/replay-sandbox
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { ProcessSpawner } from '../runtime/shell-claude-p-spawner.js';

/** `--permission-mode` for the replay session: nothing is approved implicitly. */
export const SANDBOX_PERMISSION_MODE = 'dontAsk';

/**
 * Extra argv for the replay session. Every value-taking flag uses the single
 * argument `=` form: a variadic flag placed before the positional prompt would
 * swallow the prompt.
 */
export const SANDBOX_ARGS: readonly string[] = [
  // Only user-level settings; the commit's project and local settings (hooks, env, MCP) never load.
  '--setting-sources=user',
  // No MCP server from any configuration; none is supplied.
  '--strict-mcp-config',
  // Read-only built-in tools; no Bash, Write, Edit, WebFetch or MCP tool exists in the session.
  '--tools=Read,Grep,Glob',
  '--disallowedTools=Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task,Agent',
  // Anything that would prompt is denied; nobody is there to approve it.
  '--permission-prompts=none',
  '--disable-slash-commands',
  // The session leaves no transcript, so the usage ingester cannot count the call twice.
  '--no-session-persistence',
];

/** Flags the installed `claude` must advertise, or the replay refuses to run. */
export const REQUIRED_FLAGS: readonly string[] = [
  '--setting-sources',
  '--strict-mcp-config',
  '--tools',
  '--disallowedTools',
  '--permission-mode',
  '--permission-prompts',
  '--disable-slash-commands',
  '--no-session-persistence',
];

/** Environment for the session: also ask the CLI not to load CLAUDE.md files. */
export const SANDBOX_ENV: Record<string, string> = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };

/**
 * True when the help text DEFINES the flag: an option line that starts with the
 * flag (after an optional short form), not a line that merely mentions it in
 * another option's description.
 */
export function hasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const def = `^\\s+(?:-\\w, )?(?:--[\\w-]+, )*${escaped}(?=[\\s,<=\\[]|$)`;
  return new RegExp(def, 'm').test(help);
}

/**
 * Check the installed CLI's help text for every sandbox flag. Returns an error
 * message when the sandbox cannot be applied, or undefined when it can.
 */
export function checkSandboxSupport(help: string): string | undefined {
  const missing = REQUIRED_FLAGS.filter((f) => !hasFlag(help, f));
  if (!/\bdontAsk\b/.test(help)) missing.push(`--permission-mode ${SANDBOX_PERMISSION_MODE}`);
  if (missing.length === 0) return undefined;
  return (
    `Refusing to replay: the installed claude CLI does not support the sandbox flags this ` +
    `command requires (${missing.join(', ')}). The replay runs unattended over commits that ` +
    `may contain defects and is never run in a weaker mode. Update claude and retry.`
  );
}

/** Read the installed CLI's help text, or an empty string when it cannot be run. */
export async function readClaudeHelp(runner: Runner = defaultRunner): Promise<string> {
  try {
    const r = await runner('claude', ['--help'], { allowFailure: true, timeout: 30_000 });
    return r.code === 0 ? r.stdout : '';
  } catch {
    return '';
  }
}

/** Children started by the replay and not yet exited, so a signal handler can kill them. */
const children = new Set<ChildProcess>();

/** Variable names never passed to the session: they name the operator's session or repository. */
const REMOVED_ENV_NAMES = new Set([
  'CLAUDECODE',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENV',
  'CLAUDE_REMOTE_EXECUTION',
  'INIT_CWD',
  'PWD',
  'OLDPWD',
]);
const REMOVED_ENV_PREFIXES = ['AI_SDLC_', 'npm_', 'PNPM_'];

function pathSegmentUnder(segment: string, dir: string): boolean {
  return segment === dir || segment.startsWith(`${dir}/`) || segment.startsWith(`${dir}\\`);
}

/** The repository path as given and as the filesystem resolves it (symlinks), de-duplicated. */
function repoSpellings(operatorRepo: string): string[] {
  const spellings = new Set([resolve(operatorRepo)]);
  try {
    spellings.add(realpathSync(operatorRepo));
  } catch {
    // not on disk: only the lexical spelling applies
  }
  return [...spellings];
}

/**
 * Environment for the sandboxed session. Removes the operator's Claude Code
 * session variables (CLAUDECODE, CLAUDE_PROJECT_DIR, ...), every AI_SDLC_*
 * variable (including AI_SDLC_ACTIVE_TASK_ID), package-manager variables that
 * name the repository, and any other variable whose value names the operator
 * repository. PATH keeps its entries but loses those inside the repository.
 * Everything else is kept so the CLI can run and authenticate: PATH, HOME,
 * ANTHROPIC_* (including ANTHROPIC_API_KEY), CLAUDE_CODE_OAUTH_TOKEN,
 * CLAUDE_CONFIG_DIR, cloud-provider credentials and proxy settings.
 */
export function sandboxEnvFrom(
  env: NodeJS.ProcessEnv,
  operatorRepo?: string,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const repos = operatorRepo ? repoSpellings(operatorRepo) : [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (REMOVED_ENV_NAMES.has(name) || REMOVED_ENV_PREFIXES.some((p) => name.startsWith(p))) {
      continue;
    }
    if (name === 'PATH' && repos.length > 0) {
      out[name] = value
        .split(delimiter)
        .filter((seg) => !repos.some((r) => pathSegmentUnder(seg, r)))
        .join(delimiter);
      continue;
    }
    if (repos.some((r) => value.includes(r))) continue;
    out[name] = value;
  }
  return { ...out, ...SANDBOX_ENV };
}

export interface TrackedSpawnerOptions {
  /** Operator repository root; variables naming it are not passed to the session. */
  operatorRepo?: string;
  /** Source environment (tests). Defaults to the process environment. */
  env?: NodeJS.ProcessEnv;
}

/** A process spawner that passes the scrubbed sandbox environment and tracks every child. */
export function trackedSpawner(
  inner: ProcessSpawner = nodeSpawn as ProcessSpawner,
  opts: TrackedSpawnerOptions = {},
): ProcessSpawner {
  return (command, args, options) => {
    const env = sandboxEnvFrom(opts.env ?? process.env, opts.operatorRepo);
    const child = inner(command, args, { ...options, env });
    children.add(child);
    const forget = (): void => void children.delete(child);
    child.on('close', forget);
    child.on('error', forget);
    return child;
  };
}

/** Kill every in-flight replay session. Used by signal handlers. */
export function killTrackedChildren(): number {
  let n = 0;
  for (const c of [...children]) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already gone
    }
    children.delete(c);
    n++;
  }
  return n;
}

export function trackedChildCount(): number {
  return children.size;
}
