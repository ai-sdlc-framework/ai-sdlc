/**
 * Claude Code subagent ingress shim tests (RFC-0011 §5.2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// (mkdirSync used for stub layout in the admit-clean-task case.)
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  locateBacklogTaskFile,
  refineBacklogTask,
  refusalMessage,
  stripFrontmatter,
} from './ingress-claude.js';
import type { CommentPoster, ExistingComment } from './comment-loop.js';
import type { DorConfig } from './dor-config.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-ingress-'));
  mkdirSync(join(tmp, 'backlog', 'tasks'), { recursive: true });
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

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

function writeTask(taskId: string, frontmatter: string, body: string): string {
  const path = join(tmp, 'backlog', 'tasks', `${taskId.toLowerCase()}-test.md`);
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}`);
  return path;
}

const enforceConfig: DorConfig = {
  rubricVersion: 'v1',
  evaluationMode: 'enforce',
  notifications: { authorChannel: true },
  staleness: { warnAfterDays: 14, closeAfterDays: 28, closedLabel: 'closed-as-stale-dor' },
};

const warnOnlyConfig: DorConfig = { ...enforceConfig, evaluationMode: 'warn-only' };

describe('stripFrontmatter', () => {
  it('returns body intact when no frontmatter', () => {
    const out = stripFrontmatter('# Hello');
    expect(out.title).toBe('');
    expect(out.body).toBe('# Hello');
  });

  it('extracts title and body from valid frontmatter', () => {
    const raw = "---\nid: AISDLC-1\ntitle: 'My Task'\n---\nbody here";
    const out = stripFrontmatter(raw);
    expect(out.title).toBe('My Task');
    expect(out.body).toBe('body here');
  });

  it('strips double quotes around title', () => {
    const raw = '---\ntitle: "Quoted"\n---\n';
    expect(stripFrontmatter(raw).title).toBe('Quoted');
  });
});

describe('locateBacklogTaskFile', () => {
  it('returns null when tasks dir missing', () => {
    expect(locateBacklogTaskFile('/nonexistent', 'AISDLC-1')).toBeNull();
  });

  it('returns null when no matching file', () => {
    expect(locateBacklogTaskFile(tmp, 'AISDLC-NOPE')).toBeNull();
  });

  it('finds the file by case-insensitive prefix match', () => {
    const path = writeTask('AISDLC-42', 'id: AISDLC-42', 'body');
    expect(locateBacklogTaskFile(tmp, 'AISDLC-42')).toBe(path);
  });
});

describe('refineBacklogTask', () => {
  it('throws when the task file cannot be located', async () => {
    await expect(
      refineBacklogTask('AISDLC-NOPE', { workDir: tmp, config: enforceConfig }),
    ).rejects.toThrow(/Could not locate backlog task file/);
  });

  it('admits a clean task and writes calibration log', async () => {
    // Stub the referenced files so the file-existence resolver passes.
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'index.ts'), '// stub');
    writeFileSync(join(tmp, 'src', 'index.test.ts'), '// stub');
    writeTask(
      'AISDLC-1',
      "id: AISDLC-1\ntitle: 'Clean task'",
      `## Description

Update \`src/index.ts\` to add a new subcommand.

## Acceptance criteria

- [ ] New subcommand exposed
- [ ] Test added in \`src/index.test.ts\`
`,
    );
    const author = new InMemoryPoster();
    const result = await refineBacklogTask('AISDLC-1', {
      workDir: tmp,
      config: enforceConfig,
      posters: { author },
      artifactsDir: join(tmp, 'artifacts'),
    });
    expect(result.verdict.overallVerdict).toBe('admit');
    expect(result.shouldRefuseExecution).toBe(false);
    expect(result.posts).toEqual([]);
    expect(author.comments.length).toBe(0);
    expect(result.calibrationLogPath).toContain('_dor');
  });

  it('blocks a vague task and posts a clarification comment', async () => {
    writeTask(
      'AISDLC-2',
      "id: AISDLC-2\ntitle: 'Vague task'",
      `## Description

TBD - we'll figure it out. Make search faster somehow.
`,
    );
    const author = new InMemoryPoster();
    const result = await refineBacklogTask('AISDLC-2', {
      workDir: tmp,
      config: enforceConfig,
      posters: { author },
      artifactsDir: join(tmp, 'artifacts'),
    });
    expect(result.verdict.overallVerdict).toBe('needs-clarification');
    expect(result.shouldRefuseExecution).toBe(true);
    expect(result.posts.length).toBe(1);
    expect(author.comments.length).toBe(1);
    expect(author.comments[0]!.body).toContain('Issue not yet ready for execution');
  });

  it('warn-only mode does not refuse execution even on a fail', async () => {
    writeTask('AISDLC-3', "id: AISDLC-3\ntitle: 'Vague'", 'TBD\n');
    const result = await refineBacklogTask('AISDLC-3', {
      workDir: tmp,
      config: warnOnlyConfig,
      artifactsDir: join(tmp, 'artifacts'),
    });
    expect(result.verdict.overallVerdict).toBe('needs-clarification');
    expect(result.shouldRefuseExecution).toBe(false);
  });

  it('honors taskFilePathOverride for tests / non-standard layouts', async () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'thing.ts'), '// stub');
    const odd = join(tmp, 'odd-place.md');
    writeFileSync(odd, "---\nid: x\ntitle: 'OK'\n---\n- [ ] Update `src/thing.ts` for v2\n");
    const result = await refineBacklogTask('x', {
      workDir: tmp,
      config: enforceConfig,
      taskFilePathOverride: odd,
      artifactsDir: join(tmp, 'artifacts'),
    });
    expect(result.verdict.overallVerdict).toBe('admit');
  });

  it('fans out to all enabled posters', async () => {
    writeTask('AISDLC-4', "id: AISDLC-4\ntitle: 'Vague'", 'TBD body\n');
    const author = new InMemoryPoster();
    const slack = new InMemoryPoster();
    const config: DorConfig = {
      ...enforceConfig,
      notifications: {
        authorChannel: true,
        dedicatedChannel: { slack: '#dor' },
      },
    };
    const result = await refineBacklogTask('AISDLC-4', {
      workDir: tmp,
      config,
      posters: { author, 'dedicated-slack': slack },
      artifactsDir: join(tmp, 'artifacts'),
    });
    expect(result.posts.length).toBe(2);
    expect(author.comments.length).toBe(1);
    expect(slack.comments.length).toBe(1);
  });

  it('is idempotent across re-invocations', async () => {
    writeTask('AISDLC-5', "id: AISDLC-5\ntitle: 'Vague'", 'TBD body\n');
    const author = new InMemoryPoster();
    await refineBacklogTask('AISDLC-5', {
      workDir: tmp,
      config: enforceConfig,
      posters: { author },
      artifactsDir: join(tmp, 'artifacts'),
    });
    await refineBacklogTask('AISDLC-5', {
      workDir: tmp,
      config: enforceConfig,
      posters: { author },
      artifactsDir: join(tmp, 'artifacts'),
    });
    expect(author.comments.length).toBe(1);
  });
});

describe('refusalMessage', () => {
  it('lists the failed gates inline', () => {
    const msg = refusalMessage('AISDLC-7', {
      issueId: 'AISDLC-7',
      rubricVersion: 'v1',
      overallVerdict: 'needs-clarification',
      gates: [
        { gateId: 1, verdict: 'fail', severity: 'block', stage: 'A', confidence: 'high' },
        { gateId: 5, verdict: 'fail', severity: 'block', stage: 'A', confidence: 'high' },
        { gateId: 2, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'high' },
      ],
      signedAt: '2026-05-01T00:00:00.000Z',
      evaluatorVersion: 't',
    });
    expect(msg).toContain('Refused: AISDLC-7');
    expect(msg).toContain('Gate 1');
    expect(msg).toContain('Gate 5');
    expect(msg).not.toContain('Gate 2');
  });
});
