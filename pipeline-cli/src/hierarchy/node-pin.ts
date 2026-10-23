/**
 * Node version pinning for hierarchy sessions (AISDLC-812).
 *
 * `.nvmrc` is the single source of truth for the Node version every session runs
 * under; `up` activates it through nvm in each session's start command so the
 * operator's shell default never decides, and `status` reads the version the pane's
 * processes actually run and flags a mismatch.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandRunner } from './types.js';
import { shellQuote } from './validate.js';

const VERSION_PATTERN = /^v?\d+(\.\d+){0,2}$/;

/** Strip a leading `v` and validate; undefined when `raw` is not a plain node version. */
export function normalizeNodeVersion(raw: string): string | undefined {
  const trimmed = raw.trim();
  return VERSION_PATTERN.test(trimmed) ? trimmed.replace(/^v/, '') : undefined;
}

/** The version `.nvmrc` in `dir` names, or undefined when absent or not a plain version. */
export function readNvmrc(dir: string): string | undefined {
  const file = path.join(dir, '.nvmrc');
  if (!existsSync(file)) return undefined;
  const first = readFileSync(file, 'utf-8').split('\n')[0] ?? '';
  return normalizeNodeVersion(first);
}

/** True when the installed `version` satisfies the (possibly partial) `wanted` version. */
export function versionMatches(wanted: string, actual: string): boolean {
  return actual === wanted || actual.startsWith(`${wanted}.`);
}

/** Directory nvm keeps its installs in. */
export function nvmDir(env: NodeJS.ProcessEnv): string {
  return env.NVM_DIR && env.NVM_DIR !== '' ? env.NVM_DIR : path.join(os.homedir(), '.nvm');
}

/** True when nvm has a node matching `version` installed. */
export function isNodeInstalled(version: string, env: NodeJS.ProcessEnv): boolean {
  const dir = path.join(nvmDir(env), 'versions', 'node');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((d) => versionMatches(version, d.replace(/^v/, '')));
}

/** The message `up` refuses with when the pinned version is not installed. */
export function missingNodeMessage(version: string): string {
  return `Node ${version} is not installed under nvm (${'$NVM_DIR'}/versions/node); run 'nvm install ${version}' and then 'cli-hierarchy up' again, or pass --node <version> to use another installed version`;
}

/** Shell prefix that loads nvm and activates `version`, failing the launch when it cannot. */
export function nvmActivationPrefix(version: string): string {
  return `export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 && nvm use ${shellQuote(version)} >/dev/null &&`;
}

/**
 * Node version of the pane's own session, read from the process table (an nvm-managed
 * node path contains `/versions/node/v<version>/`). Takes the shallowest process in the
 * pane's tree, so child processes such as MCP servers are ignored. Undefined when no
 * such process is found or `ps` cannot be read.
 */
export function paneNodeVersion(run: CommandRunner, panePid: number): string | undefined {
  if (panePid <= 0) return undefined;
  const r = run('ps', ['-A', '-o', 'pid=,ppid=,comm=']);
  if (r.status !== 0) return undefined;
  const procs: { pid: number; ppid: number; comm: string }[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: (m[3] ?? '').trim() });
  }
  // Breadth-first from the pane: the session's own shell/claude sits at the shallowest
  // depth that runs an nvm node; MCP servers and other tools it spawns sit deeper and
  // may run under a different Node (AISDLC-906).
  let level = new Set<number>([panePid]);
  const seen = new Set<number>(level);
  while (level.size > 0) {
    for (const p of procs) {
      if (!level.has(p.pid)) continue;
      const m = /\/versions\/node\/v(\d+\.\d+\.\d+)\//.exec(p.comm);
      if (m) return m[1];
    }
    const next = new Set<number>();
    for (const p of procs) {
      if (level.has(p.ppid) && !seen.has(p.pid)) {
        seen.add(p.pid);
        next.add(p.pid);
      }
    }
    level = next;
  }
  return undefined;
}
