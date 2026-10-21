/**
 * Filing pacing (AISDLC-986): `cli-file --pr` spaces PR filings against the installation
 * `GITHUB_TOKEN` REST bucket (5000 calls per hour shared by every CI job). Before a PR is
 * opened it reads `gh api rate_limit`, prints the remaining calls and reset time, and
 * enforces a spacing since the last filing recorded on the board: wait, or `--queue` a brief.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { now as clockNow } from '../clock.js';
import { DEFAULT_BOARD_DIR } from '../dispatch/board.js';

export const DEFAULT_SPACING_MINUTES = 15;
export const SPACING_ENV = 'AI_SDLC_FILE_SPACING_MINUTES';

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  /** Reset time, ISO 8601. */
  resetAt: string;
}

export interface PacingDeps {
  /** Runs `gh api rate_limit` and returns stdout, or null when the call fails. */
  readRateLimit(cwd: string): string | null;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export const defaultPacingDeps: PacingDeps = {
  readRateLimit(cwd) {
    const r = spawnSync('gh', ['api', 'rate_limit'], { cwd, encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout) : null;
  },
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  log: (line) => process.stderr.write(`${line}\n`),
};

export function parseRateLimit(stdout: string): RateLimitInfo | null {
  try {
    const core = (JSON.parse(stdout) as { resources?: { core?: Record<string, number> } }).resources
      ?.core;
    if (!core || typeof core.remaining !== 'number') return null;
    return {
      remaining: core.remaining,
      limit: core.limit,
      resetAt: new Date(core.reset * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

/** Spacing in minutes: flag, then environment config, then the default. */
export function resolveSpacingMinutes(flag?: number, env = process.env): number {
  if (flag !== undefined && Number.isFinite(flag) && flag >= 0) return flag;
  const fromEnv = Number(env[SPACING_ENV]);
  if (env[SPACING_ENV] !== undefined && Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_SPACING_MINUTES;
}

const stampFile = (repo: string) => join(repo, DEFAULT_BOARD_DIR, 'last-filing.json');

export function readLastFiling(repo: string): Date | null {
  const f = stampFile(repo);
  if (!existsSync(f)) return null;
  try {
    const d = new Date((JSON.parse(readFileSync(f, 'utf8')) as { ts: string }).ts);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export function recordFiling(repo: string): void {
  const f = stampFile(repo);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify({ ts: clockNow().toISOString() })}\n`);
}

/** Write the queued-filing brief for the next window; returns its path. */
export function queueFiling(repo: string, id: string, command: string, notBefore: Date): string {
  const dest = join(repo, DEFAULT_BOARD_DIR, 'queued-filings', `filing-${id.toLowerCase()}.md`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(
    dest,
    `# Queued filing: ${id}\n\nQueued by \`cli-file --pr --queue\` (AISDLC-986) to pace PR filings against the installation rate-limit bucket.\n\nNot before: ${notBefore.toISOString()}\n\nRun: \`${command}\`\n`,
  );
  return dest;
}

export type PacingOutcome = 'proceed' | 'queued';

/**
 * Print the bucket, then enforce the spacing. Waits until the spacing has elapsed, or with
 * `queue` writes a brief and returns 'queued' (the caller must then skip the filing).
 */
export async function paceFiling(
  repo: string,
  opts: { id: string; command: string; spacingMinutes?: number; queue?: boolean },
  deps: PacingDeps = defaultPacingDeps,
): Promise<PacingOutcome> {
  const raw = deps.readRateLimit(repo);
  const info = raw === null ? null : parseRateLimit(raw);
  deps.log(
    info
      ? `[cli-file] installation bucket: ${info.remaining}/${info.limit} calls remaining, resets ${info.resetAt}`
      : '[cli-file] installation bucket: unreadable (gh api rate_limit failed)',
  );
  const spacingMs = resolveSpacingMinutes(opts.spacingMinutes) * 60_000;
  const last = readLastFiling(repo);
  if (last === null) return 'proceed';
  const readyAt = new Date(last.getTime() + spacingMs);
  const waitMs = readyAt.getTime() - clockNow().getTime();
  if (waitMs <= 0) return 'proceed';
  if (opts.queue) {
    const path = queueFiling(repo, opts.id, opts.command, readyAt);
    deps.log(
      `[cli-file] spacing not elapsed; queued filing brief ${path} (not before ${readyAt.toISOString()})`,
    );
    return 'queued';
  }
  deps.log(
    `[cli-file] spacing not elapsed; waiting ${Math.ceil(waitMs / 1000)}s until ${readyAt.toISOString()}`,
  );
  await deps.sleep(waitMs);
  return 'proceed';
}
