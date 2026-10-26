/**
 * Live context size of a session (AISDLC-1066): the last assistant record's `usage` in the session's
 * transcript (`~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`), read by seeking from the end of the
 * file so a multi-megabyte transcript is never loaded whole.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { resolveThresholds } from './thresholds.js';
import { readSessionRegistry } from './registry.js';
import type { HierarchyDeps, RegistrySession, RosterEntry } from './types.js';

/** Bytes read per backward step. */
export const TAIL_CHUNK_BYTES = 64 * 1024;
/** Upper bound on bytes read in total; an assistant record is far smaller than this. */
export const TAIL_MAX_BYTES = 1024 * 1024;

/** Transcript directory name the harness derives from a working directory. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Path of a session transcript under the harness projects directory. */
export function transcriptPath(projectsDir: string, cwd: string, sessionId: string): string {
  return path.join(projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function contextOfLine(line: string): number | undefined {
  if (!line.includes('"usage"')) return undefined;
  try {
    const rec = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: Usage } };
    const usage = rec.message?.usage;
    if (!usage || (rec.type !== 'assistant' && rec.message?.role !== 'assistant')) return undefined;
    return (
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    );
  } catch {
    return undefined; // a partial first line of a chunk, or a malformed record
  }
}

/**
 * Context tokens of the last assistant record in `file`, or undefined when the file is missing,
 * unreadable or holds no such record within `TAIL_MAX_BYTES` of its end.
 */
export function readContextTokens(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < TAIL_MAX_BYTES) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const data = Buffer.concat([buf, carry]);
      const nl = data.indexOf(0x0a);
      const lines = (start === 0 ? data : data.subarray(nl + 1)).toString('utf-8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const v = contextOfLine(lines[i] ?? '');
        if (v !== undefined) return v;
      }
      carry = nl < 0 ? data : data.subarray(0, nl);
      end = start;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Render k tokens with the OVER / unknown flags, e.g. `450k OVER`, `?`. */
export function formatContext(tokens: number | undefined, over: boolean | undefined): string {
  if (tokens === undefined) return '?';
  return `${Math.round(tokens / 1000)}k${over ? ' OVER' : ''}`;
}

/** Context tokens of a live registry session, from its transcript; undefined when unknown. */
export function sessionContextTokens(
  deps: Pick<HierarchyDeps, 'registryDir' | 'cwd'>,
  live: RegistrySession | undefined,
): number | undefined {
  if (!live?.sessionId) return undefined;
  const projectsDir = path.join(path.dirname(deps.registryDir), 'projects');
  return readContextTokens(transcriptPath(projectsDir, live.cwd ?? deps.cwd, live.sessionId));
}

/** One warning line per roster session whose context is above its clear threshold. */
export function overContextWarnings(
  deps: Pick<HierarchyDeps, 'registryDir' | 'cwd' | 'boardDir'>,
  roster: readonly RosterEntry[],
): string[] {
  const registry = readSessionRegistry(deps.registryDir);
  const t = resolveThresholds(deps.boardDir);
  return roster.flatMap((e) => {
    const live = registry.find((r) => r.name === e.name);
    const tokens = sessionContextTokens(deps, live);
    return tokens !== undefined && tokens > t[e.role]
      ? [contextWarning(e.name, tokens, t[e.role])]
      : [];
  });
}

/** The warning text shared by `status` and `up`. */
export function contextWarning(name: string, tokens: number, threshold: number): string {
  return `warning: ${name} context ${formatContext(tokens, false)} is over its ${Math.round(threshold / 1000)}k clear threshold; the hooks module should have rotated it (check MODULE)`;
}
