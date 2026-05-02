/**
 * AISDLC-115.4 AC #7 — end-to-end: vague issue → DoR comment posted →
 * author edits → re-check → admitted as ready.
 *
 * This test composes the real comment-loop + ingress-claude modules
 * against an in-memory poster to exercise the full lifecycle the way
 * the GitHub Action and Claude Code subagent shims will at runtime.
 * No network, no LLM — Stage A alone is enough to drive both verdicts
 * (the BEFORE state fails Gates 1/2/5 deterministically; the AFTER
 * state passes Stage A clean).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bodyForChannel,
  dorCommentMarkerFor,
  fanoutPost,
  renderAdmitComment,
  type CommentPoster,
  type ExistingComment,
} from './comment-loop.js';
import { refineBacklogTask } from './ingress-claude.js';
import type { DorConfig } from './dor-config.js';

const enforceConfig: DorConfig = {
  rubricVersion: 'v1',
  evaluationMode: 'enforce',
  notifications: { authorChannel: true },
  staleness: { warnAfterDays: 14, closeAfterDays: 28, closedLabel: 'closed-as-stale-dor' },
  autoPassRules: [],
  escalation: { maxRoundsBeforeHumanTriage: 3 },
  bypassRequiresRole: 'maintainer',
};

class InMemoryPoster implements CommentPoster {
  comments: ExistingComment[] = [];
  nextId = 1;
  async list(): Promise<ExistingComment[]> {
    return [...this.comments];
  }
  async create(body: string): Promise<string> {
    const id = `c${this.nextId++}`;
    this.comments.push({ id, body });
    return id;
  }
  async update(commentId: string, body: string): Promise<void> {
    const idx = this.comments.findIndex((c) => c.id === commentId);
    if (idx >= 0) this.comments[idx] = { id: commentId, body };
  }
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-e2e-'));
  mkdirSync(join(tmp, 'backlog', 'tasks'), { recursive: true });
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function writeTask(taskId: string, body: string): string {
  const path = join(tmp, 'backlog', 'tasks', `${taskId.toLowerCase()}-test.md`);
  writeFileSync(path, `---\nid: ${taskId}\ntitle: 'Test'\n---\n${body}`);
  return path;
}

describe('AC #7 — vague → comment → edit → re-check → admit', () => {
  it('completes the full author-edit loop with idempotent comment updates', async () => {
    const taskId = 'AISDLC-E2E';
    const author = new InMemoryPoster();
    const artifactsDir = join(tmp, 'artifacts');

    // ── Step 1: Author creates a vague issue.
    const vagueBody = `## Description

Make search faster.

TBD - we'll figure out the details later.

(no surface, no AC list)
`;
    writeTask(taskId, vagueBody);

    // ── Step 2: Ingress shim runs DoR → posts the clarification comment.
    const round1 = await refineBacklogTask(taskId, {
      workDir: tmp,
      config: enforceConfig,
      posters: { author },
      artifactsDir,
    });
    expect(round1.verdict.overallVerdict).toBe('needs-clarification');
    expect(round1.shouldRefuseExecution).toBe(true);
    expect(author.comments.length).toBe(1);
    const clarification = author.comments[0]!;
    expect(clarification.body).toContain(dorCommentMarkerFor('author'));
    expect(clarification.body).toContain('Issue not yet ready for execution');

    // ── Step 3: Author edits the issue to a well-formed version.
    // Stub the file the body references so the file-existence resolver
    // passes against the tmp workDir.
    mkdirSync(join(tmp, 'apps', 'web', 'api'), { recursive: true });
    writeFileSync(join(tmp, 'apps', 'web', 'api', 'search.ts'), '// stub');
    const fixedBody = `## Description

Add server-side response compression to the customer-facing site search at \`apps/web/api/search.ts\`.

## Acceptance criteria

- [ ] Brotli compression enabled on the search response handler
- [ ] p95 response payload size drops by >= 60% on the standard 100-result fixture
- [ ] Existing latency budget (p95 < 200ms) preserved
`;
    writeTask(taskId, fixedBody);

    // ── Step 4: Re-check picks up the new body and admits the task.
    const round2 = await refineBacklogTask(taskId, {
      workDir: tmp,
      config: enforceConfig,
      posters: { author },
      artifactsDir,
    });
    expect(round2.verdict.overallVerdict).toBe('admit');
    expect(round2.shouldRefuseExecution).toBe(false);

    // ── Step 5: Admit comment is posted via the same channel marker so
    // the prior clarification comment is UPDATED in place (idempotency,
    // RFC §6.2).
    const admitBody = renderAdmitComment(round2.verdict);
    const admitResults = await fanoutPost(
      { author },
      bodyForChannel(admitBody, 'author'),
      enforceConfig.notifications,
    );
    expect(admitResults).toHaveLength(1);
    expect(admitResults[0]!.action).toBe('updated');
    // Still exactly one comment on the issue — never two.
    expect(author.comments.length).toBe(1);
    expect(author.comments[0]!.body).toContain('Issue ready for execution');
    expect(author.comments[0]!.body).not.toContain('Issue not yet ready for execution');
  });

  it('re-running the same DoR check is a no-op on the comment', async () => {
    const taskId = 'AISDLC-E2E-2';
    const author = new InMemoryPoster();
    const artifactsDir = join(tmp, 'artifacts');
    writeTask(taskId, `## Description\n\nTBD - we'll figure it out. Make search faster.\n`);
    await refineBacklogTask(taskId, {
      workDir: tmp,
      config: enforceConfig,
      posters: { author },
      artifactsDir,
    });
    expect(author.comments.length).toBe(1);
    // Re-run with no edits — idempotent, no new comment, no churn on the body.
    const beforeBody = author.comments[0]!.body;
    await refineBacklogTask(taskId, {
      workDir: tmp,
      config: enforceConfig,
      posters: { author },
      artifactsDir,
    });
    expect(author.comments.length).toBe(1);
    expect(author.comments[0]!.body).toBe(beforeBody);
  });

  it('dual-fanout posts to author + dedicated channel simultaneously', async () => {
    const taskId = 'AISDLC-E2E-3';
    const author = new InMemoryPoster();
    const slack = new InMemoryPoster();
    const config: DorConfig = {
      ...enforceConfig,
      notifications: {
        authorChannel: true,
        dedicatedChannel: { slack: '#dor', github_team: '@org/triage' },
      },
    };
    const ghTeam = new InMemoryPoster();
    writeTask(taskId, `TBD body without ACs.\n`);
    const result = await refineBacklogTask(taskId, {
      workDir: tmp,
      config,
      posters: {
        author,
        'dedicated-slack': slack,
        'dedicated-github': ghTeam,
      },
      artifactsDir: join(tmp, 'artifacts'),
    });
    expect(result.posts.length).toBe(3);
    expect(author.comments.length).toBe(1);
    expect(slack.comments.length).toBe(1);
    expect(ghTeam.comments.length).toBe(1);
    expect(slack.comments[0]!.body).toContain(dorCommentMarkerFor('dedicated-slack'));
    expect(ghTeam.comments[0]!.body).toContain(dorCommentMarkerFor('dedicated-github'));
  });

  it('corpus fixture 11-author-edit-re-check.md matches expected verdict', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(import.meta.url);
    // Walk upward from this test file looking for the spec/dor-corpus dir.
    let dir = here;
    let fixturePath: string | null = null;
    for (let i = 0; i < 8; i++) {
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
      const candidate = join(dir, 'spec', 'dor-corpus', 'edge-cases', '11-author-edit-re-check.md');
      if (existsSync(candidate)) {
        fixturePath = candidate;
        break;
      }
    }
    if (!fixturePath) {
      // Test only meaningful when run from inside the repo; skip silently otherwise.
      return;
    }
    const body = readFileSync(fixturePath, 'utf8');
    const taskId = 'AISDLC-FIX-11';
    writeTask(taskId, body);
    const result = await refineBacklogTask(taskId, {
      workDir: tmp,
      config: enforceConfig,
      artifactsDir: join(tmp, 'artifacts'),
    });
    expect(result.verdict.overallVerdict).toBe('needs-clarification');
  });
});
