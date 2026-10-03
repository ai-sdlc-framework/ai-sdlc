/**
 * The executor's own process and git access.
 *
 * Probe agents are never given Bash. Everything a probe needs that a file read
 * cannot give it (a file's committed content, the diff between two commits, the
 * output of an allowlisted command) is produced here, by the executor, with
 * `execFile` (no shell), fixed argument vectors, a scrubbed environment, bounded
 * output, and a timeout, and is then handed to the probe as redacted, fenced data.
 *
 * @module review-plan/executor-git
 */

import { execFile } from 'node:child_process';
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A full commit SHA in lowercase hex (SHA-1 or SHA-256). */
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** The longest prefix of `s` that fits in `maxBytes` UTF-8 bytes without splitting a character. */
export function utf8Prefix(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Drop the trailing partial line of text that was cut at a byte limit, so a cut
 * can never leave a fragment of a token behind.
 */
export function dropPartialLine(text: string): string {
  return text.slice(0, Math.max(0, text.lastIndexOf('\n')));
}

// ── Scrubbed environment ─────────────────────────────────────────────────

let scratchHome: string | undefined;

/** An empty home directory for child processes, so no user config or credentials are read. */
function emptyHome(): string {
  scratchHome ??= mkdtempSync(join(tmpdir(), 'review-exec-home-'));
  return scratchHome;
}

/**
 * The environment for a child process, built from an allowlist: PATH, LANG, LC_*,
 * TMPDIR, plus fixed values. Nothing else is copied, so no token or credential in
 * the parent's environment reaches a child, and every `GIT_*` variable
 * (`GIT_EXTERNAL_DIFF`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*`,
 * and the rest) is dropped. The fixed values isolate git from system and global
 * configuration and stop it from prompting.
 */
export function scrubbedEnv(
  source: NodeJS.ProcessEnv = process.env,
  home: string = emptyHome(),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key.startsWith('GIT_')) continue;
    if (key === 'PATH' || key === 'LANG' || key === 'TMPDIR' || key.startsWith('LC_'))
      env[key] = value;
  }
  env.HOME = home;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

// ── git ──────────────────────────────────────────────────────────────────

export interface GitResult {
  stdout: Buffer;
  /** True when the output hit `maxBytes` and was cut. */
  truncated: boolean;
}

export interface GitRunOpts {
  cwd: string;
  maxBytes: number;
  timeoutMs: number;
}

/** Runs git with a fixed argument vector. Rejects on a non-zero exit. */
export type GitRunner = (args: readonly string[], opts: GitRunOpts) => Promise<GitResult>;

export const runGit: GitRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', ...args],
      {
        cwd: opts.cwd,
        env: scrubbedEnv(),
        encoding: 'buffer',
        maxBuffer: opts.maxBytes,
        timeout: opts.timeoutMs,
        windowsHide: true,
      },
      (err, stdout) => {
        if (!err) {
          resolve({ stdout, truncated: false });
          return;
        }
        // On a maxBuffer overflow Node passes the partial output as the callback's stdout
        // argument (the error object does not carry it), so keep that and mark the cut.
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({
            stdout: Buffer.from(stdout ?? '').subarray(0, opts.maxBytes),
            truncated: true,
          });
          return;
        }
        reject(err);
      },
    );
  });

const GIT_TIMEOUT_MS = 30_000;
const TREE_ENTRY_MAX_BYTES = 64 * 1024;

/** Resolve `HEAD` to a full commit SHA, or `undefined` when that cannot be done. */
export async function resolvePinnedHead(
  git: GitRunner,
  repoRoot: string,
): Promise<string | undefined> {
  try {
    const r = await git(['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: repoRoot,
      maxBytes: 1024,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const sha = r.stdout.toString('utf8').trim();
    return FULL_SHA.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** A path that git could read as an option, or that cannot be a path at all. */
function unsafeGitPath(p: string): boolean {
  return p.length === 0 || p.startsWith('-') || p.includes('\0');
}

export type BlobResult =
  | { kind: 'ok'; text: string; truncated: boolean; bytesRead: number }
  | { kind: 'absent' }
  | { kind: 'refused'; reason: 'not-a-regular-file' | 'unsafe-path' | 'unreadable' };

/**
 * Read a file as committed at `sha`: `git ls-tree` for the entry's mode and object id,
 * then `git cat-file blob` for that object. Only a regular file (mode 100644 or 100755)
 * is read; a symlink (120000), a gitlink (160000) or a tree is refused. A path with no
 * entry in the tree is `absent`.
 */
export async function readBlobAtCommit(
  git: GitRunner,
  repoRoot: string,
  sha: string,
  path: string,
  maxBytes: number,
): Promise<BlobResult> {
  if (unsafeGitPath(path) || !FULL_SHA.test(sha)) return { kind: 'refused', reason: 'unsafe-path' };
  const listing = await git(['ls-tree', '-z', sha, '--', path], {
    cwd: repoRoot,
    maxBytes: TREE_ENTRY_MAX_BYTES,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  for (const entry of listing.stdout.toString('utf8').split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0 || entry.slice(tab + 1) !== path) continue;
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    if ((mode !== '100644' && mode !== '100755') || type !== 'blob')
      return { kind: 'refused', reason: 'not-a-regular-file' };
    if (!oid || !/^[0-9a-f]{40,64}$/.test(oid)) return { kind: 'refused', reason: 'unreadable' };
    const blob = await git(['cat-file', 'blob', oid], {
      cwd: repoRoot,
      maxBytes,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const text = blob.stdout.toString('utf8');
    return {
      kind: 'ok',
      text: blob.truncated ? dropPartialLine(text) : text,
      truncated: blob.truncated,
      bytesRead: blob.stdout.length,
    };
  }
  return { kind: 'absent' };
}

/**
 * The diff between the merge-base and the pinned head commit, for the given tracked
 * paths (or the whole change when none are named). Both revisions must be full SHAs.
 * External diff drivers and text conversion are off.
 */
export async function readDiff(
  git: GitRunner,
  repoRoot: string,
  mergeBase: string,
  head: string,
  paths: readonly string[],
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!FULL_SHA.test(mergeBase) || !FULL_SHA.test(head))
    throw new Error('diff revisions must be full commit SHAs');
  if (paths.some(unsafeGitPath)) throw new Error('unsafe path for git');
  const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
  const opts = { cwd: repoRoot, timeoutMs: GIT_TIMEOUT_MS };
  let stat = '';
  if (paths.length === 0) {
    const s = await git([...base, '--stat', mergeBase, head, '--'], {
      ...opts,
      maxBytes: Math.min(maxBytes, 16 * 1024),
    });
    stat = `${s.stdout.toString('utf8')}\n`;
  }
  const d = await git([...base, mergeBase, head, '--', ...paths], { ...opts, maxBytes });
  const body = d.stdout.toString('utf8');
  return { text: stat + (d.truncated ? dropPartialLine(body) : body), truncated: d.truncated };
}

// ── allowlisted commands ─────────────────────────────────────────────────

export interface CommandRunOpts {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

export interface CommandResult {
  exitStatus: number;
  /** Standard output, then standard error, bounded to `maxBytes`. */
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Runs one command given as an argument vector. Never rejects. */
export type CommandRunner = (
  argv: readonly string[],
  opts: CommandRunOpts,
) => Promise<CommandResult>;

/**
 * Run a command with `execFile` (no shell) in its own process group, so a timeout
 * can kill the command and everything it started. Output is bounded.
 */
export const runCommand: CommandRunner = (argv, opts) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    // `detached` is honoured by the child_process spawn that execFile wraps, but is missing from
    // ExecFileOptions in the type definitions.
    const options: ExecFileOptionsWithStringEncoding & { detached: boolean } = {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      maxBuffer: opts.maxBytes,
      encoding: 'utf8',
      windowsHide: true,
    };
    const child = execFile(
      file ?? '',
      args,
      options,
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        for (const t of timers) clearTimeout(t);
        const e = err as { code?: string | number; signal?: string } | null;
        let exitStatus = 0;
        let capped = false;
        if (timedOut) exitStatus = 124;
        else if (e) {
          if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            capped = true;
            exitStatus = -1;
          } else if (typeof e.code === 'number') exitStatus = e.code;
          else exitStatus = e.signal ? -1 : 127;
        }
        const combined = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`;
        const kept = utf8Prefix(combined, opts.maxBytes);
        resolve({
          exitStatus,
          output: kept,
          truncated: capped || kept.length < combined.length,
          timedOut,
        });
      },
    );
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);
    timers.push(killTimer);
  });
