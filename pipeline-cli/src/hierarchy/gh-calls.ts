/**
 * Append-only log of every `gh` call a hierarchy session makes (AISDLC-963).
 *
 * `<board>/gh-calls.jsonl` gets one JSON line per call: timestamp, session, argv, exit status
 * and the remaining quota when `gh api -i` printed it. The runner in `runtime/exec.ts` writes
 * the lines for its own calls; a `gh` shim first on each session PATH writes them for callers
 * that spawn `gh` directly, then execs the real binary.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const GH_CALLS_FILENAME = 'gh-calls.jsonl';
/** Env var naming the log file; sessions get it at launch. */
export const GH_CALL_LOG_ENV = 'AI_SDLC_GH_CALL_LOG';
/** Set by the runner on its child so the shim does not log the same call twice. */
export const GH_CALL_LOGGED_ENV = 'AI_SDLC_GH_CALL_LOGGED';
/** Default floor of remaining quota below which the dispatch tick skips GitHub reads. */
export const DEFAULT_QUOTA_FLOOR = 300;
const HOUR_MS = 3_600_000;
const RETENTION_MS = 24 * HOUR_MS;

export interface GhCall {
  at: string;
  session: string;
  argv: string[];
  exit: number;
  remaining?: number;
}

export interface Quota {
  core?: number;
  graphql?: number;
}

export function ghCallsPath(boardDir: string): string {
  return path.join(boardDir, GH_CALLS_FILENAME);
}

/** Parse `x-ratelimit-remaining` out of `gh api -i` output. */
export function parseRemaining(stdout: string): number | undefined {
  const m = /^x-ratelimit-remaining:\s*(\d+)/im.exec(stdout);
  return m ? Number(m[1]) : undefined;
}

/** Append one call; never throws (logging must not fail a gh call). */
export function appendGhCall(logPath: string, call: GhCall): void {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(call)}\n`);
  } catch {
    /* best effort */
  }
}

export function readGhCalls(logPath: string): GhCall[] {
  let text: string;
  try {
    text = readFileSync(logPath, 'utf-8');
  } catch {
    return [];
  }
  const calls: GhCall[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as GhCall;
      if (typeof c.at === 'string') calls.push(c);
    } catch {
      /* skip a torn line */
    }
  }
  return calls;
}

/** Keep the last 24 hours; returns how many lines were dropped. */
export function pruneGhCalls(logPath: string, now: Date): number {
  const calls = readGhCalls(logPath);
  const cutoff = now.getTime() - RETENTION_MS;
  const kept = calls.filter((c) => Date.parse(c.at) >= cutoff);
  const dropped = calls.length - kept.length;
  if (dropped > 0) {
    writeFileSync(logPath, kept.map((c) => `${JSON.stringify(c)}\n`).join(''));
  }
  return dropped;
}

/** Calls in the last hour, by session. */
export function callsPerSession(calls: GhCall[], now: Date): Record<string, number> {
  const since = now.getTime() - HOUR_MS;
  const out: Record<string, number> = {};
  for (const c of calls) {
    if (Date.parse(c.at) < since) continue;
    out[c.session] = (out[c.session] ?? 0) + 1;
  }
  return out;
}

/** Parse the `gh api rate_limit` JSON. */
export function parseQuota(stdout: string): Quota | undefined {
  try {
    const r = (JSON.parse(stdout) as { resources?: Record<string, { remaining?: number }> })
      .resources;
    if (!r) return undefined;
    return {
      ...(typeof r.core?.remaining === 'number' ? { core: r.core.remaining } : {}),
      ...(typeof r.graphql?.remaining === 'number' ? { graphql: r.graphql.remaining } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The lower of the known buckets, or undefined when unknown. */
export function lowestRemaining(q: Quota | undefined): number | undefined {
  const v = [q?.core, q?.graphql].filter((n): n is number => typeof n === 'number');
  return v.length > 0 ? Math.min(...v) : undefined;
}

/** Shell shim: logs the call, then runs the real gh found on the PATH without the shim dir. */
export const GH_SHIM = `#!/bin/sh
self_dir=$(cd "$(dirname "$0")" && pwd)
PATH=$(printf %s "$PATH" | tr ':' '\\n' | grep -vxF "$self_dir" | paste -sd: -)
real=$(command -v gh) || { echo "gh: not found" >&2; exit 127; }
if [ -n "$${GH_CALL_LOGGED_ENV}" ] || [ -z "$${GH_CALL_LOG_ENV}" ]; then exec "$real" "$@"; fi
out=$(mktemp)
"$real" "$@" > "$out"
code=$?
cat "$out"
node -e '
const fs = require("fs");
const m = /^x-ratelimit-remaining:\\s*(\\d+)/im.exec(fs.readFileSync(process.argv[1], "utf8"));
const c = { at: (new Date).toISOString(), session: process.env.AI_SDLC_HIERARCHY_SESSION || "-", argv: process.argv.slice(3), exit: Number(process.argv[2]) };
if (m) c.remaining = Number(m[1]);
fs.appendFileSync(process.env.${GH_CALL_LOG_ENV}, JSON.stringify(c) + "\\n");
' "$out" "$code" "$@" 2>/dev/null
rm -f "$out"
exit $code
`;

/** Write the shim into `<board>/bin/gh`; returns the directory to put first on PATH. */
export function installGhShim(boardDir: string): string {
  const dir = path.join(boardDir, 'bin');
  const file = path.join(dir, 'gh');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file) || readFileSync(file, 'utf-8') !== GH_SHIM) {
    writeFileSync(file, GH_SHIM);
  }
  chmodSync(file, 0o755);
  return dir;
}
