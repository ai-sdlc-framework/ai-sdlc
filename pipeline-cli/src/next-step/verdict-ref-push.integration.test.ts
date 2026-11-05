import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRequiredReviewers } from '../attestation/review-coverage.js';
import { checkVerdict } from '../attestation/verdict-check.js';
import { defaultRunner } from '../runtime/exec.js';
import type { VerdictRecordDraft } from '../attestation/verdict-record.js';
import { buildVerdictRefspec } from './verdict-ref-push.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const CHANGED = ['b.md'];
const REQUIRED = computeRequiredReviewers({ changedPaths: CHANGED });
const DRAFT: VerdictRecordDraft = {
  verdict: 'approved',
  reviewers: REQUIRED.required.map((name) => ({
    name,
    harness: 'claude-code',
    model: '',
    independenceTier: 'none' as const,
    verdict: 'approved' as const,
  })),
  coverage: { policy: REQUIRED.policy, required: [...REQUIRED.required], satisfied: true },
  leaves: [],
};

let root: string;
let wt: string;
let bare: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verdict-push-'));
  bare = join(root, 'remote.git');
  wt = join(root, 'wt');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'init', '-q', '-b', 'main', wt);
  git(wt, 'config', 'user.email', 't@t');
  git(wt, 'config', 'user.name', 't');
  git(wt, 'config', 'commit.gpgsign', 'false');
  // The remote URL must parse as github.com; insteadOf routes the real traffic to the bare repo.
  git(wt, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  git(wt, 'config', `url.${bare}.insteadOf`, 'https://github.com/o/r.git');
  writeFileSync(join(wt, 'a.md'), 'a\n');
  git(wt, 'add', 'a.md');
  git(wt, 'commit', '-q', '-m', 'base');
  git(wt, 'push', '-q', 'origin', 'main');
  git(wt, 'fetch', '-q', 'origin');
  git(wt, 'checkout', '-q', '-b', 'feat');
  writeFileSync(join(wt, 'b.md'), 'b\n');
  git(wt, 'add', 'b.md');
  git(wt, 'commit', '-q', '-m', 'change');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The Step 11 loop: rebuild the refspec per attempt, push the branch atomically with it. */
async function pushLoop(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const v = await buildVerdictRefspec(defaultRunner, wt, DRAFT, 'origin/main');
    const args = v.refspec
      ? ['push', '-u', '--atomic', 'origin', 'feat', v.refspec]
      : ['push', '-u', 'origin', 'feat'];
    const r = await defaultRunner('git', args, { cwd: wt, allowFailure: true });
    if (r.code === 0) return;
  }
  throw new Error('push failed');
}

describe('verdict ref against a local bare remote (AISDLC-1193)', () => {
  it('a fresh round pushes a ref that verdict-check accepts', async () => {
    await pushLoop();
    const head = git(wt, 'rev-parse', 'HEAD');
    const res = await checkVerdict({
      runner: defaultRunner,
      cwd: wt,
      headSha: head,
      changedPaths: CHANGED,
    });
    expect(res.code).toBe('ok');
  });

  it('when the pre-push hook adds a commit, the ref names the final pushed sha', async () => {
    const hook = join(wt, '.git', 'hooks', 'pre-push');
    writeFileSync(
      hook,
      '#!/bin/sh\nif [ ! -f .signed ]; then touch .signed; git add -f .signed; git commit -q -m sign; exit 1; fi\nexit 0\n',
    );
    chmodSync(hook, 0o755);
    const before = git(wt, 'rev-parse', 'HEAD');
    await pushLoop();
    const head = git(wt, 'rev-parse', 'HEAD');
    expect(head).not.toBe(before);
    const refs = git(root, '--git-dir', bare, 'for-each-ref', 'refs/ai-sdlc/verdicts/');
    expect(refs).toContain(`refs/ai-sdlc/verdicts/${head}`);
    expect(refs).not.toContain(before);
    expect(git(root, '--git-dir', bare, 'rev-parse', 'feat')).toBe(head);
  });
});
