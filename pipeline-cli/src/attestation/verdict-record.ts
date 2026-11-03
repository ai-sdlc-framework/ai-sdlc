/**
 * RFC-0061 Phase 1: the `ai-sdlc/review-verdict/v1` record, its leaves digest, and the git
 * plumbing that stores it as a two-file tree on `refs/ai-sdlc/verdicts/<headSha>`.
 *
 * @module attestation/verdict-record
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { now as clockNow } from '../clock.js';
import type { Runner } from '../runtime/exec.js';

export const VERDICT_RECORD_SCHEMA = 'ai-sdlc/review-verdict/v1';
export const VERDICT_REF_PREFIX = 'refs/ai-sdlc/verdicts/';
export const RECORD_FILE = 'record.json';
export const LEAVES_FILE = 'leaves.jsonl';

/** The shipped RFC-0046 values. */
export const INDEPENDENCE_TIERS = ['none', 'attested', 'isolated'] as const;
export type IndependenceTier = (typeof INDEPENDENCE_TIERS)[number];

const sha = z.string().regex(/^[0-9a-f]{40,64}$/);

export const VerdictRecordSchema = z.object({
  schema: z.literal(VERDICT_RECORD_SCHEMA),
  subject: z.object({
    headSha: sha,
    treeSha: sha,
    baseSha: sha,
    repository: z.string().min(1),
    /** 0 when the PR is not yet open at issue time (Step 11 pushes before `gh pr create`). */
    pullRequest: z.number().int().nonnegative(),
  }),
  verdict: z.enum(['approved', 'changes_requested']),
  reviewers: z.array(
    z.object({
      name: z.string().min(1),
      harness: z.string().min(1),
      model: z.string(),
      independenceTier: z.enum(INDEPENDENCE_TIERS),
      verdict: z.enum(['approved', 'changes_requested']),
    }),
  ),
  coverage: z.object({
    policy: z.string().min(1),
    required: z.array(z.string()),
    satisfied: z.boolean(),
  }),
  evidence: z.object({
    leaves: z.literal(LEAVES_FILE),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
  issuedBy: z.object({
    principal: z.enum(['pipeline-step-11', 'ci-clean-room']),
    at: z.string().min(1),
  }),
  carriedForwardFrom: z.string().nullable(),
});

export type VerdictRecord = z.infer<typeof VerdictRecordSchema>;
export type VerdictReviewer = VerdictRecord['reviewers'][number];

/** What Step 8 knows: everything except the subject, the evidence digest and the issuer. */
export interface VerdictRecordDraft {
  verdict: VerdictRecord['verdict'];
  reviewers: VerdictReviewer[];
  coverage: VerdictRecord['coverage'];
  /** One JSON-serialisable object per reviewer leaf. */
  leaves: Array<Record<string, unknown>>;
}

/** `leaves.jsonl` content: one compact JSON object per line, no Merkle construction. */
export function serializeLeaves(leaves: ReadonlyArray<Record<string, unknown>>): string {
  return leaves.map((l) => JSON.stringify(l)).join('\n') + (leaves.length > 0 ? '\n' : '');
}

export function leavesDigest(leavesJsonl: string): string {
  return `sha256:${createHash('sha256').update(leavesJsonl).digest('hex')}`;
}

export interface FinalizeOpts {
  subject: VerdictRecord['subject'];
  principal?: VerdictRecord['issuedBy']['principal'];
  now?: Date;
}

/** Step 11: complete a Step 8 draft with the head it is issued for. Returns record and leaves. */
export function finalizeVerdictRecord(
  draft: VerdictRecordDraft,
  opts: FinalizeOpts,
): { record: VerdictRecord; leavesJsonl: string } {
  const leavesJsonl = serializeLeaves(draft.leaves);
  const record = VerdictRecordSchema.parse({
    schema: VERDICT_RECORD_SCHEMA,
    subject: opts.subject,
    verdict: draft.verdict,
    reviewers: draft.reviewers,
    coverage: draft.coverage,
    evidence: { leaves: LEAVES_FILE, digest: leavesDigest(leavesJsonl) },
    issuedBy: {
      principal: opts.principal ?? 'pipeline-step-11',
      at: (opts.now ?? clockNow()).toISOString().replace(/\.\d+Z$/, 'Z'),
    },
    carriedForwardFrom: null,
  });
  return { record, leavesJsonl };
}

/** True when the record's digest matches the given leaves content. */
export function recordMatchesLeaves(record: VerdictRecord, leavesJsonl: string): boolean {
  return record.evidence.digest === leavesDigest(leavesJsonl);
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'ai-sdlc-step-11',
  GIT_AUTHOR_EMAIL: 'ai-sdlc-step-11@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'ai-sdlc-step-11',
  GIT_COMMITTER_EMAIL: 'ai-sdlc-step-11@users.noreply.github.com',
};

/**
 * Write a commit whose tree holds exactly `record.json` and `leaves.jsonl` (via a private index,
 * so the worktree and its real index are untouched). Returns the commit sha, or null on failure.
 */
export async function writeVerdictCommit(
  runner: Runner,
  cwd: string,
  record: VerdictRecord,
  leavesJsonl: string,
): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-ref-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index'), ...IDENTITY };
    const files: Array<[string, string]> = [
      [RECORD_FILE, JSON.stringify(record, null, 2) + '\n'],
      [LEAVES_FILE, leavesJsonl],
    ];
    for (const [name, content] of files) {
      const p = join(dir, name);
      writeFileSync(p, content);
      const blob = await runner('git', ['hash-object', '-w', p], { cwd, allowFailure: true });
      if (blob.code !== 0) return null;
      const add = await runner(
        'git',
        ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${name}`],
        { cwd, env, allowFailure: true },
      );
      if (add.code !== 0) return null;
    }
    const tree = await runner('git', ['write-tree'], { cwd, env, allowFailure: true });
    if (tree.code !== 0) return null;
    const commit = await runner(
      'git',
      [
        'commit-tree',
        tree.stdout.trim(),
        '-m',
        `review verdict ${record.verdict} for ${record.subject.headSha}`,
      ],
      { cwd, env, allowFailure: true },
    );
    return commit.code === 0 ? commit.stdout.trim() : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function verdictRefName(headSha: string): string {
  return `${VERDICT_REF_PREFIX}${headSha}`;
}
