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

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

/**
 * Drop everything from the first PEM `-----BEGIN` marker that has no `-----END` after
 * it. Text cut at a byte cap can end inside a private-key block, and the redactor
 * cannot recognise a block whose END is missing.
 */
export function dropUnterminatedPem(text: string): string {
  // A BEGIN with no END after it opens a block the cut left unterminated. Only the last END
  // matters: every BEGIN after it is unterminated, so cut at the first one. Linear time.
  const lastEnd = text.lastIndexOf('-----END');
  const begin = text.indexOf('-----BEGIN', lastEnd < 0 ? 0 : lastEnd);
  return begin < 0 ? text : text.slice(0, begin);
}

/** For text cut at a byte cap: drop the partial last line, then any unterminated PEM block. */
export function trimTruncated(text: string): string {
  return dropUnterminatedPem(dropPartialLine(text));
}

// ── Scrubbed environment ─────────────────────────────────────────────────

let scratchHome: string | undefined;

/** Remove the scratch home directory, if one was created. For tests and shutdown. */
export function disposeScratchHome(): void {
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
  scratchHome = undefined;
}

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
  // Paths are literal names, never pathspec patterns.
  env.GIT_LITERAL_PATHSPECS = '1';
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
const TREE_LIST_MAX_BYTES = 64 * 1024 * 1024;

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

/**
 * Every regular file (mode 100644 or 100755) in the tree of commit `sha`. Symlinks
 * (120000) and gitlinks (160000) are left out. A truncated listing is an error.
 */
export async function listRegularFilesAtCommit(
  git: GitRunner,
  repoRoot: string,
  sha: string,
): Promise<string[]> {
  if (!FULL_SHA.test(sha)) throw new Error('tree listing needs a full commit SHA');
  const r = await git(['ls-tree', '-r', '-z', sha], {
    cwd: repoRoot,
    maxBytes: TREE_LIST_MAX_BYTES,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.truncated) throw new Error('tree listing was truncated');
  const out: string[] = [];
  for (const entry of r.stdout.toString('utf8').split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type] = entry.slice(0, tab).split(' ');
    if ((mode === '100644' || mode === '100755') && type === 'blob') out.push(entry.slice(tab + 1));
  }
  return out;
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
      text: blob.truncated ? trimTruncated(text) : text,
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
  return { text: stat + (d.truncated ? trimTruncated(body) : body), truncated: d.truncated };
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

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Cap one stream. A stream that hit its cap loses its partial last line and any open PEM block. */
function capStream(
  text: string,
  limit: number,
  overflowed: boolean,
): { text: string; cut: boolean } {
  if (byteLen(text) > limit) return { text: trimTruncated(utf8Prefix(text, limit)), cut: true };
  return overflowed ? { text: trimTruncated(text), cut: true } : { text, cut: false };
}

/**
 * Run a command with no shell, in its own process group, so a timeout or an output
 * overflow can kill the command and everything it started. The promise always settles:
 * on a timeout the pipes are destroyed, so a grandchild that outlives the command and
 * holds them open cannot hang the caller. Output is bounded per stream.
 */
export const runCommand: CommandRunner = (argv, opts) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    let child: ChildProcess;
    try {
      child = spawn(file ?? '', args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve({ exitStatus: 127, output: '', truncated: false, timedOut: false });
      return;
    }
    const chunks: Record<'out' | 'err', Buffer[]> = { out: [], err: [] };
    const sizes = { out: 0, err: 0 };
    let overflowed = false;
    let timedOut = false;
    let settled = false;
    const timers: { kill?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {};

    const settle = (exitStatus: number): void => {
      if (settled) return;
      settled = true;
      if (timers.kill) clearTimeout(timers.kill);
      if (timers.grace) clearTimeout(timers.grace);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const outText = Buffer.concat(chunks.out).toString('utf8');
      const errText = Buffer.concat(chunks.err).toString('utf8');
      const o = capStream(outText, opts.maxBytes, overflowed);
      const e = capStream(errText, Math.max(0, opts.maxBytes - byteLen(o.text)), overflowed);
      resolve({
        exitStatus,
        output: e.text ? `${o.text}\n[stderr]\n${e.text}` : o.text,
        truncated: o.cut || e.cut,
        timedOut,
      });
    };

    const collect =
      (key: 'out' | 'err') =>
      (chunk: Buffer): void => {
        if (sizes[key] < opts.maxBytes) {
          chunks[key].push(chunk);
          sizes[key] += chunk.length;
        }
        if (sizes[key] >= opts.maxBytes && !overflowed && chunk.length > 0) {
          // At or past the cap: more output than we keep may follow, so stop the command.
          overflowed = true;
          killGroup(child);
        }
      };
    child.stdout?.on('data', collect('out'));
    child.stderr?.on('data', collect('err'));
    child.on('error', () => settle(127));
    child.on('close', (code) => settle(code ?? -1));
    // If the pipes stay open after the command exits, settle shortly after the exit.
    child.on('exit', (code) => {
      timers.grace = setTimeout(() => settle(code ?? -1), 500);
    });
    timers.kill = setTimeout(() => {
      timedOut = true;
      killGroup(child);
      settle(124);
    }, opts.timeoutMs);
  });
