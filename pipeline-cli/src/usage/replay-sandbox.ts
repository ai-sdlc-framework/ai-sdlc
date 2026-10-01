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

function hasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,])${escaped}(?=[\\s,<=\\[]|$)`, 'm').test(help);
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

/** A process spawner that passes the sandbox environment and tracks every child. */
export function trackedSpawner(
  inner: ProcessSpawner = nodeSpawn as ProcessSpawner,
): ProcessSpawner {
  return (command, args, options) => {
    const child = inner(command, args, { ...options, env: { ...process.env, ...SANDBOX_ENV } });
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
