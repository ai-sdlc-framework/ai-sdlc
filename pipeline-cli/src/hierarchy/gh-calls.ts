/**
 * Append-only log of every `gh` call a hierarchy session makes (AISDLC-963).
 *
 * `<board>/gh-calls.jsonl` gets one JSON line per call: timestamp, session, argv, exit status
 * and the remaining quota when `gh api -i` printed it. The runner in `runtime/exec.ts` writes
 * the lines for its own calls; a `gh` shim first on each session PATH writes them for callers
 * that spawn `gh` directly, then execs the real binary.
 *
 * AISDLC-1439: a failed call also records the first line of its stderr (`error`) and whether it was
 * a rate-limit refusal (`rateLimited`); at most once per hour per session a `gh api rate_limit`
 * snapshot (`quota`, per resource remaining/limit/reset) is appended, so `cli-hierarchy gh-usage
 * report` can show headroom over a week. Lines are kept for 8 days.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
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
/** Long enough for the weekly `gh-usage report` (AISDLC-1439). */
const RETENTION_MS = 8 * 24 * HOUR_MS;
/** Longest error text kept on a ledger line. */
const ERROR_MAX = 300;

/** Flags whose value can carry a credential or private text; the value is never logged. */
const SECRET_FLAGS = new Set([
  '-H',
  '--header',
  '-f',
  '-F',
  '--raw-field',
  '--field',
  '-b',
  '--body',
  '--input',
]);

/** Argv safe to keep on disk: values of header, field and body flags are replaced. */
export function redactArgv(argv: string[]): string[] {
  const out: string[] = [];
  let hide = false;
  for (const a of argv) {
    if (hide) {
      out.push('***');
      hide = false;
    } else if (SECRET_FLAGS.has(a)) {
      out.push(a);
      hide = true;
    } else if (/^--(header|raw-field|field|body|input)=/.test(a)) {
      out.push(`${a.slice(0, a.indexOf('='))}=***`);
    } else {
      out.push(a);
    }
  }
  return out;
}

/** Parse the quota floor env value; anything but a non-negative number gives the default. */
export function parseQuotaFloor(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_QUOTA_FLOOR;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_QUOTA_FLOOR;
}

export interface GhCall {
  at: string;
  session: string;
  argv: string[];
  exit: number;
  remaining?: number;
  /** `x-ratelimit-resource` printed by `gh api -i` alongside `remaining`. */
  resource?: string;
  /** First non-empty stderr line of a failed call (AISDLC-1439). */
  error?: string;
  /** True when the failure was a rate-limit refusal (AISDLC-1439). */
  rateLimited?: boolean;
  /** Per-resource quota from a `gh api rate_limit` snapshot (AISDLC-1439). */
  quota?: QuotaSnapshot;
  /** Which token made the call; absent means the local user token. CI writes `actions`. */
  token?: string;
  /** CI only: the workflow run the snapshot belongs to. */
  runId?: string;
  /** CI only: failed jobs whose log contains `API rate limit exceeded`. */
  rateLimitedJobs?: string[];
}

export interface QuotaBucket {
  remaining: number;
  limit?: number;
  /** Epoch seconds of the next reset. */
  reset?: number;
}

export type QuotaSnapshot = Record<string, QuotaBucket>;

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

/** Parse `x-ratelimit-resource` out of `gh api -i` output. */
export function parseResource(stdout: string): string | undefined {
  const m = /^x-ratelimit-resource:\s*([\w-]+)/im.exec(stdout);
  return m ? m[1] : undefined;
}

/** Text GitHub uses for a primary or secondary rate-limit refusal. */
const RATE_LIMIT_RE = /rate limit exceeded|secondary rate limit|abuse detection/i;

export function isRateLimitError(text: string): boolean {
  return RATE_LIMIT_RE.test(text);
}

/** `error` and `rateLimited` for a failed call; empty for a success. */
export function failureFields(exit: number, stderr: string): Pick<GhCall, 'error' | 'rateLimited'> {
  if (exit === 0) return {};
  const first = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return {
    ...(first ? { error: first.slice(0, ERROR_MAX) } : {}),
    rateLimited: isRateLimitError(stderr),
  };
}

/** True when `argv` is the unmetered `gh api rate_limit` read. */
export function isRateLimitRead(argv: readonly string[]): boolean {
  return argv[0] === 'api' && argv.includes('rate_limit');
}

/** Per-resource remaining/limit/reset out of the `gh api rate_limit` JSON. */
export function parseQuotaSnapshot(stdout: string): QuotaSnapshot | undefined {
  try {
    const r = (JSON.parse(stdout) as { resources?: Record<string, Partial<QuotaBucket>> })
      .resources;
    if (!r || typeof r !== 'object') return undefined;
    const out: QuotaSnapshot = {};
    for (const name of ['core', 'graphql', 'search']) {
      const b = r[name];
      if (typeof b?.remaining !== 'number') continue;
      out[name] = {
        remaining: b.remaining,
        ...(typeof b.limit === 'number' ? { limit: b.limit } : {}),
        ...(typeof b.reset === 'number' ? { reset: b.reset } : {}),
      };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Stamp file marking a session's last quota snapshot. */
export function quotaStampPath(logPath: string, session: string): string {
  return `${logPath}.quota-${session.replace(/[^\w.-]/g, '_')}`;
}

/**
 * Claim this session's hourly quota snapshot: true (and the stamp is renewed) when the last one is
 * an hour old or missing. Bounds the extra `gh api rate_limit` calls to one per hour per session.
 */
export function claimQuotaSnapshot(logPath: string, session: string, now: Date): boolean {
  const stamp = quotaStampPath(logPath, session);
  try {
    const last = Date.parse(readFileSync(stamp, 'utf-8').trim());
    if (Number.isFinite(last) && now.getTime() - last < HOUR_MS && last <= now.getTime()) {
      return false;
    }
  } catch {
    /* no stamp yet */
  }
  try {
    mkdirSync(path.dirname(stamp), { recursive: true });
    writeFileSync(stamp, now.toISOString());
    return true;
  } catch {
    return false;
  }
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
  return parseGhCallLines(text);
}

/** Calls in the last `bytes` of the log; the first, possibly torn, line is skipped (AISDLC-1440). */
export function readGhCallsTail(logPath: string, bytes = 2 * 1024 * 1024): GhCall[] {
  let fd: number | undefined;
  try {
    fd = openSync(logPath, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf-8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return parseGhCallLines(text);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseGhCallLines(text: string): GhCall[] {
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
    // Write beside the log and rename so a reader never sees a half-written file.
    const tmp = `${logPath}.${process.pid}.tmp`;
    writeFileSync(tmp, kept.map((c) => `${JSON.stringify(c)}\n`).join(''));
    renameSync(tmp, logPath);
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

/**
 * AISDLC-1440: the local token's quota as the ledger last saw it, so nothing polls
 * `gh api rate_limit` for it: the newest hourly snapshot per bucket, replaced by any newer
 * `x-ratelimit-remaining` a `gh api -i` call printed. A bucket whose reset has passed, or with no
 * reset and older than an hour, is unknown (the window refilled it). CI lines are ignored.
 */
export function ledgerQuota(calls: readonly GhCall[], now: Date): Quota | undefined {
  const seen: Partial<Record<keyof Quota, { remaining: number; at: number; reset?: number }>> = {};
  const set = (name: string, remaining: number, at: number, reset?: number): void => {
    if (name !== 'core' && name !== 'graphql') return;
    const prev = seen[name];
    if (prev && prev.at > at) return;
    // A newer reading without a reset stays in the earlier reading's window until it ends.
    const keep =
      reset ?? (prev?.reset !== undefined && prev.reset * 1000 > at ? prev.reset : undefined);
    seen[name] = { remaining, at, ...(keep !== undefined ? { reset: keep } : {}) };
  };
  for (const c of calls) {
    if (c.token !== undefined && c.token !== USER_TOKEN_NAME) continue;
    const at = Date.parse(c.at);
    if (!Number.isFinite(at)) continue;
    for (const [name, b] of Object.entries(c.quota ?? {})) set(name, b.remaining, at, b.reset);
    if (typeof c.remaining === 'number' && c.resource) set(c.resource, c.remaining, at);
  }
  const t = now.getTime();
  const out: Quota = {};
  for (const name of ['core', 'graphql'] as const) {
    const b = seen[name];
    if (!b || b.at > t) continue;
    const live = b.reset !== undefined ? b.reset * 1000 > t : t - b.at < HOUR_MS;
    if (live) out[name] = b.remaining;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `token` value of the local user token, when a line names it at all. */
const USER_TOKEN_NAME = 'user';

/** The lower of the known buckets, or undefined when unknown. */
export function lowestRemaining(q: Quota | undefined): number | undefined {
  const v = [q?.core, q?.graphql].filter((n): n is number => typeof n === 'number');
  return v.length > 0 ? Math.min(...v) : undefined;
}

/**
 * Shell shim: logs the call, then runs the real gh found on the PATH without the shim dir.
 * stdout and stderr are buffered so a failure's first stderr line can be logged (AISDLC-1439);
 * `auth` stays unbuffered for interactive prompts. The hourly quota snapshot mirrors
 * `claimQuotaSnapshot` and `parseQuotaSnapshot`.
 */
export const GH_SHIM = `#!/bin/sh
self_dir=$(cd "$(dirname "$0")" && pwd)
PATH=$(printf %s "$PATH" | tr ':' '\\n' | grep -vxF "$self_dir" | paste -sd: -)
real=$(command -v gh) || { echo "gh: not found" >&2; exit 127; }
if [ -n "$${GH_CALL_LOGGED_ENV}" ] || [ -z "$${GH_CALL_LOG_ENV}" ] ; then exec "$real" "$@"; fi
if [ "$1" = auth ]; then
  # Logged too, but unbuffered so interactive prompts (gh auth login) keep working.
  out=/dev/null
  err=/dev/null
  "$real" "$@"
  code=$?
else
  out=$(mktemp)
  err=$(mktemp)
  trap 'rm -f "$out" "$err"' EXIT INT TERM HUP
  "$real" "$@" > "$out" 2> "$err"
  code=$?
  cat "$out"
  cat "$err" >&2
fi
node -e '
const fs = require("fs");
const [outFile, errFile, codeArg, real, ...args] = process.argv.slice(1);
const out = fs.readFileSync(outFile, "utf8");
const m = /^x-ratelimit-remaining:\\s*(\\d+)/im.exec(out);
const res = /^x-ratelimit-resource:\\s*([\\w-]+)/im.exec(out);
const secret = new Set(${JSON.stringify([...SECRET_FLAGS])});
const argv = []; let hide = false;
for (const a of args) {
  if (hide) { argv.push("***"); hide = false; }
  else if (secret.has(a)) { argv.push(a); hide = true; }
  else if (/^--(header|raw-field|field|body|input)=/.test(a)) argv.push(a.slice(0, a.indexOf("=")) + "=***");
  else argv.push(a);
}
const log = process.env.${GH_CALL_LOG_ENV};
const session = process.env.AI_SDLC_HIERARCHY_SESSION || "-";
const now = new Date;
const exit = Number(codeArg);
const c = { at: now.toISOString(), session, argv, exit };
if (m) c.remaining = Number(m[1]);
if (m && res) c.resource = res[1];
const quota = (text) => {
  try {
    const r = JSON.parse(text).resources; const q = {};
    for (const n of ["core", "graphql", "search"]) {
      const b = r && r[n];
      if (b && typeof b.remaining === "number") q[n] = { remaining: b.remaining, limit: b.limit, reset: b.reset };
    }
    return Object.keys(q).length ? q : undefined;
  } catch { return undefined; }
};
if (exit !== 0) {
  const e = fs.readFileSync(errFile, "utf8");
  const first = e.split("\\n").map((l) => l.trim()).find((l) => l !== "");
  if (first) c.error = first.slice(0, ${ERROR_MAX});
  c.rateLimited = ${RATE_LIMIT_RE.toString()}.test(e);
}
const stamp = log + ".quota-" + session.replace(/[^\\w.-]/g, "_");
const isRead = args[0] === "api" && args.includes("rate_limit");
if (isRead && exit === 0) { const q = quota(out); if (q) { c.quota = q; fs.writeFileSync(stamp, c.at); } }
fs.appendFileSync(log, JSON.stringify(c) + "\\n");
if (!isRead) {
  let last = NaN;
  try { last = Date.parse(fs.readFileSync(stamp, "utf8").trim()); } catch {}
  if (!(now - last < ${HOUR_MS} && last <= +now)) {
    fs.writeFileSync(stamp, c.at);
    const env = { ...process.env, ${GH_CALL_LOGGED_ENV}: "1" };
    const r = require("child_process").spawnSync(real, ["api", "rate_limit"], { env, encoding: "utf8", timeout: 30000 });
    const s = { at: (new Date).toISOString(), session, argv: ["api", "rate_limit"], exit: r.status === null ? 1 : r.status };
    const q = r.status === 0 ? quota(r.stdout) : undefined;
    if (q) s.quota = q;
    fs.appendFileSync(log, JSON.stringify(s) + "\\n");
  }
}
' "$out" "$err" "$code" "$real" "$@" 2>/dev/null
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
