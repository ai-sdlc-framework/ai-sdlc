/**
 * AISDLC-546 — durable persistence of the Decision Catalog event log.
 *
 * `cli-decisions add|answer|escalate` only append to the local working-tree
 * `.ai-sdlc/_decisions/events.jsonl`. In a Pattern-C repo the parent checkout is
 * periodically `git reset --hard origin/main`-ed by `check-orchestrator-state.sh`,
 * which wipes un-synced appends and lets the next `add` reuse the freed DEC-NNNN.
 *
 * This module closes both holes without touching the caller's working tree or index:
 *
 *  1. `persistDecisionLog()` builds a commit with git plumbing (temporary index) whose
 *     tree is `origin/main` plus the merged ledger, and pushes it to a dedicated sync
 *     branch (`ai-sdlc/decisions-sync`). The ledger on that branch is the union of
 *     origin/main, the previous sync-branch tip, and the local ledger (line-level, so
 *     nothing is ever dropped). A draft PR is opened best-effort via `gh`.
 *  2. `nextDecisionIdDurable()` / `assertDecisionIdFree()` derive numbering from
 *     max(local, origin/main, sync branch) after a fetch, so a freed number can't be reissued.
 *
 * Everything degrades gracefully: no git repo / no `origin` / offline / no `gh` yields a
 * stderr warning (persist) or the local-only answer (numbering). Disable entirely with
 * `AI_SDLC_DECISIONS_NO_REMOTE_PERSIST=1`. The runner is injectable so tests never touch
 * the network.
 *
 * The sync push uses `--no-verify`: the commit is machine-generated, touches only the
 * attestation-exempt `_decisions` path, and lands on a dedicated ref, so the dev-branch
 * pre-push gates (coverage, attestation) do not apply.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

import { formatDecisionId, validateDecisionEvent } from './decision-record.js';
import { resolveEventLogPath } from './event-log.js';

export const DECISIONS_SYNC_BRANCH = 'ai-sdlc/decisions-sync';
const LEDGER_REL = '.ai-sdlc/_decisions/events.jsonl';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type GitRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string },
) => RunResult;

export const defaultRunner: GitRunner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export interface DurableOpts {
  workDir: string;
  runner?: GitRunner;
  env?: NodeJS.ProcessEnv;
  /** Warning sink (defaults to stderr). */
  warn?: (msg: string) => void;
}

export function isRemotePersistDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.AI_SDLC_DECISIONS_NO_REMOTE_PERSIST ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

interface Ctx {
  root: string;
  ledgerRel: string;
  run: (
    cmd: string,
    args: string[],
    extra?: { env?: NodeJS.ProcessEnv; input?: string },
  ) => RunResult;
}

function makeCtx(opts: DurableOpts): Ctx | null {
  const runner = opts.runner ?? defaultRunner;
  const probe = runner('git', ['rev-parse', '--show-toplevel'], { cwd: opts.workDir });
  if (probe.status !== 0) return null;
  const root = probe.stdout.trim();
  if (!root) return null;
  const remote = runner('git', ['remote', 'get-url', 'origin'], { cwd: root });
  if (remote.status !== 0) return null;
  const ledgerRel = relative(
    realpathSync(root),
    join(realpathSync(opts.workDir), '.ai-sdlc', '_decisions', 'events.jsonl'),
  )
    .split('\\')
    .join('/');
  if (ledgerRel.startsWith('..')) return null;
  return {
    root,
    ledgerRel: ledgerRel || LEDGER_REL,
    run: (cmd, args, extra) =>
      runner(cmd, args, { cwd: root, env: extra?.env ?? opts.env, input: extra?.input }),
  };
}

function lines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim() !== '');
}

function showRef(ctx: Ctx, ref: string): string[] {
  const r = ctx.run('git', ['show', `${ref}:${ctx.ledgerRel}`]);
  return r.status === 0 ? lines(r.stdout) : [];
}

function fetchRefs(ctx: Ctx): boolean {
  // Best-effort; the sync branch may not exist yet (that fetch failing is normal).
  const main = ctx.run('git', ['fetch', '--quiet', 'origin', 'main']);
  ctx.run('git', [
    'fetch',
    '--quiet',
    'origin',
    `+refs/heads/${DECISIONS_SYNC_BRANCH}:refs/remotes/origin/${DECISIONS_SYNC_BRANCH}`,
  ]);
  return main.status === 0;
}

function idsOf(ls: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of ls) {
    try {
      const evt = JSON.parse(l) as unknown;
      if (validateDecisionEvent(evt) === null) {
        out.add((evt as { decisionId: string }).decisionId);
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function localLines(workDir: string): string[] {
  const p = resolveEventLogPath(workDir);
  return existsSync(p) ? lines(readFileSync(p, 'utf8')) : [];
}

/** Every decision id known to origin/main or the sync branch (empty when no remote). */
export function remoteDecisionIds(opts: DurableOpts): Set<string> {
  if (isRemotePersistDisabled(opts.env)) return new Set();
  const ctx = makeCtx(opts);
  if (!ctx) return new Set();
  fetchRefs(ctx);
  return idsOf([
    ...showRef(ctx, 'refs/remotes/origin/main'),
    ...showRef(ctx, `refs/remotes/origin/${DECISIONS_SYNC_BRANCH}`),
  ]);
}

/**
 * Next DEC-NNNN id = max(local ledger, origin/main ledger, sync-branch ledger) + 1.
 * A number consumed anywhere durable can never be reissued.
 */
export function nextDecisionIdDurable(opts: DurableOpts): string {
  const ids = new Set<string>([...idsOf(localLines(opts.workDir)), ...remoteDecisionIds(opts)]);
  let max = 0;
  for (const id of ids) {
    const m = id.match(/^DEC-(\d+)$/);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return formatDecisionId(max + 1);
}

/** Throw when an explicit id is already consumed on the remote ledger (collision refusal). */
export function assertDecisionIdFree(id: string, opts: DurableOpts): void {
  if (remoteDecisionIds(opts).has(id)) {
    throw new Error(
      `${id} already exists on the committed decision ledger (origin/main or ${DECISIONS_SYNC_BRANCH}); refusing to reuse a consumed decision number`,
    );
  }
}

export interface PersistResult {
  persisted: boolean;
  reason?: string;
  commit?: string;
  prUrl?: string;
}

/**
 * Commit the merged ledger to the sync branch and push it. Never throws; never touches the
 * caller's working tree, index or HEAD.
 */
export function persistDecisionLog(opts: DurableOpts): PersistResult {
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + '\n'));
  if (isRemotePersistDisabled(opts.env)) return { persisted: false, reason: 'disabled' };
  try {
    const ctx = makeCtx(opts);
    if (!ctx) return { persisted: false, reason: 'no git remote' };
    if (!fetchRefs(ctx)) {
      warn('[decisions] WARN: could not fetch origin main; decision kept locally only');
      return { persisted: false, reason: 'fetch failed' };
    }
    const syncRef = `refs/remotes/origin/${DECISIONS_SYNC_BRANCH}`;
    const main = showRef(ctx, 'refs/remotes/origin/main');
    const merged = [...main];
    const seen = new Set(merged);
    for (const l of [...showRef(ctx, syncRef), ...localLines(opts.workDir)]) {
      if (!seen.has(l)) {
        seen.add(l);
        merged.push(l);
      }
    }
    if (merged.length === main.length) return { persisted: true, reason: 'already on main' };

    const blob = ctx.run('git', ['hash-object', '-w', '--stdin'], {
      input: merged.join('\n') + '\n',
    });
    if (blob.status !== 0) throw new Error(`hash-object: ${blob.stderr.trim()}`);

    const gitDir = ctx.run('git', ['rev-parse', '--absolute-git-dir']).stdout.trim();
    const idx = join(gitDir, `decisions-sync-index-${process.pid}`);
    const env = { ...(opts.env ?? process.env), GIT_INDEX_FILE: idx };
    try {
      const steps: string[][] = [
        ['read-tree', 'refs/remotes/origin/main'],
        ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${ctx.ledgerRel}`],
      ];
      for (const s of steps) {
        const r = ctx.run('git', s, { env });
        if (r.status !== 0) throw new Error(`${s[0]}: ${r.stderr.trim()}`);
      }
      const tree = ctx.run('git', ['write-tree'], { env });
      if (tree.status !== 0) throw new Error(`write-tree: ${tree.stderr.trim()}`);
      const commit = ctx.run(
        'git',
        [
          '-c',
          'user.name=ai-sdlc-decisions',
          '-c',
          'user.email=decisions@ai-sdlc.invalid',
          'commit-tree',
          tree.stdout.trim(),
          '-p',
          'refs/remotes/origin/main',
          '-m',
          'chore(decisions): sync decision catalog event log (AISDLC-546)',
        ],
        { env },
      );
      if (commit.status !== 0) throw new Error(`commit-tree: ${commit.stderr.trim()}`);
      const sha = commit.stdout.trim();

      const prev = ctx.run('git', ['rev-parse', '--verify', '--quiet', syncRef]);
      const lease =
        prev.status === 0
          ? `--force-with-lease=refs/heads/${DECISIONS_SYNC_BRANCH}:${prev.stdout.trim()}`
          : `--force-with-lease=refs/heads/${DECISIONS_SYNC_BRANCH}:`;
      const push = ctx.run('git', [
        'push',
        '--no-verify',
        '--quiet',
        lease,
        'origin',
        `${sha}:refs/heads/${DECISIONS_SYNC_BRANCH}`,
      ]);
      if (push.status !== 0) throw new Error(`push: ${push.stderr.trim()}`);

      const prUrl = openSyncPr(ctx);
      return { persisted: true, commit: sha, ...(prUrl ? { prUrl } : {}) };
    } finally {
      rmSync(idx, { force: true });
    }
  } catch (err) {
    warn(
      `[decisions] WARN: could not persist decision log to the remote (${(err as Error).message}); kept locally`,
    );
    return { persisted: false, reason: (err as Error).message };
  }
}

function openSyncPr(ctx: Ctx): string | undefined {
  const existing = ctx.run('gh', [
    'pr',
    'list',
    '--head',
    DECISIONS_SYNC_BRANCH,
    '--state',
    'open',
    '--json',
    'url',
    '--jq',
    '.[0].url',
  ]);
  if (existing.status !== 0) return undefined; // gh missing / unauthenticated: branch push is enough
  if (existing.stdout.trim()) return existing.stdout.trim();
  const created = ctx.run('gh', [
    'pr',
    'create',
    '--draft',
    '--base',
    'main',
    '--head',
    DECISIONS_SYNC_BRANCH,
    '--title',
    'chore(decisions): sync decision catalog event log',
    '--body',
    'Automated by `cli-decisions` (AISDLC-546). Persists Decision Catalog events (append-only, attestation-exempt `.ai-sdlc/_decisions/`) so a Pattern-C parent reset cannot lose them or reuse a DEC number.',
  ]);
  return created.status === 0 ? created.stdout.trim() || undefined : undefined;
}
