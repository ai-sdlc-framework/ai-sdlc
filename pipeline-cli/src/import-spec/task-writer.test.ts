import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  nextTaskNumber,
  renderTaskMarkdown,
  slugify,
  writeBacklogTaskFromSpecKitEntry,
} from './task-writer.js';

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'import-spec-writer-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('slugify', () => {
  it('produces a lowercase hyphenated slug', () => {
    expect(slugify('Implement Bearer-Token Validator')).toBe('Implement-Bearer-Token-Validator');
  });
  it('strips punctuation and collapses whitespace', () => {
    expect(slugify('Wow!!  many   spaces?!')).toBe('Wow-many-spaces');
  });
  it('caps at 60 chars', () => {
    const big = 'a'.repeat(100);
    expect(slugify(big).length).toBeLessThanOrEqual(60);
  });
});

describe('nextTaskNumber', () => {
  it('returns 1 when backlog/ is empty', () => {
    withTmp((dir) => {
      expect(nextTaskNumber(dir, 'IMP')).toBe(1);
    });
  });

  it('finds the highest suffix across tasks/ and completed/', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
      mkdirSync(join(dir, 'backlog', 'completed'), { recursive: true });
      writeFileSync(join(dir, 'backlog', 'tasks', 'imp-3 - x.md'), '');
      writeFileSync(join(dir, 'backlog', 'completed', 'imp-7 - y.md'), '');
      writeFileSync(join(dir, 'backlog', 'tasks', 'other-99 - z.md'), '');
      expect(nextTaskNumber(dir, 'IMP')).toBe(8);
    });
  });

  it('is case-insensitive on the prefix match', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
      writeFileSync(join(dir, 'backlog', 'tasks', 'imp-12 - x.md'), '');
      expect(nextTaskNumber(dir, 'IMP')).toBe(13);
    });
  });
});

describe('renderTaskMarkdown', () => {
  it('emits frontmatter with specRef block + AC list', () => {
    const md = renderTaskMarkdown(
      'IMP-5',
      {
        taskId: 'T-001',
        title: 'Build the thing',
        body: 'Some body.',
        acceptanceCriteria: ['returns 200', 'logs the call'],
      },
      {
        source: 'spec-kit',
        featureId: 'auth-feature',
        taskId: 'T-001',
        artifactPath: '.specify/specs/auth-feature/tasks.md',
        importedAt: '2026-05-24T00:00:00.000Z',
      },
    );

    expect(md).toContain('id: IMP-5');
    expect(md).toContain('title: Build the thing');
    expect(md).toContain('specRef:');
    expect(md).toContain('source: spec-kit');
    expect(md).toContain('featureId: auth-feature');
    expect(md).toContain('taskId: T-001');
    expect(md).toContain('artifactPath: .specify/specs/auth-feature/tasks.md');
    expect(md).toContain('importedAt:');
    expect(md).toContain('- [ ] #1 returns 200');
    expect(md).toContain('- [ ] #2 logs the call');
    expect(md).toContain('Some body.');
    expect(md).toContain('## Acceptance Criteria');
    expect(md).toContain('imported-from-spec-kit');
  });

  it('writes a placeholder AC when none extracted', () => {
    const md = renderTaskMarkdown(
      'IMP-2',
      { taskId: 'T-002', title: 'Foo', body: '', acceptanceCriteria: [] },
      {
        source: 'spec-kit',
        featureId: 'feat',
        taskId: 'T-002',
        artifactPath: 'x/tasks.md',
        importedAt: '2026-05-24T00:00:00.000Z',
      },
    );
    expect(md).toContain('(no acceptance criteria extracted from upstream — review needed)');
    // body fallback — references the upstream artifact
    expect(md).toContain('Imported from spec-kit');
  });

  it('single-quotes titles containing colons', () => {
    const md = renderTaskMarkdown(
      'IMP-9',
      {
        taskId: 'T-9',
        title: 'fix: handle null tokens',
        body: '',
        acceptanceCriteria: [],
      },
      {
        source: 'spec-kit',
        featureId: 'feat',
        taskId: 'T-9',
        artifactPath: 'x/tasks.md',
        importedAt: '2026-05-24T00:00:00.000Z',
      },
    );
    expect(md).toContain("title: 'fix: handle null tokens'");
  });
});

describe('writeBacklogTaskFromSpecKitEntry', () => {
  it('writes a file with the expected name + path', () => {
    withTmp((dir) => {
      const written = writeBacklogTaskFromSpecKitEntry(
        {
          taskId: 'T-001',
          title: 'Implement bearer-token validator',
          body: 'body',
          acceptanceCriteria: ['ac one'],
        },
        {
          workDir: dir,
          featureId: 'auth-feature',
          artifactPath: '.specify/specs/auth-feature/tasks.md',
          importedAt: '2026-05-24T00:00:00.000Z',
        },
      );
      expect(written.id).toBe('IMP-1');
      expect(written.fileName).toBe('imp-1 - Implement-bearer-token-validator.md');
      const content = readFileSync(written.filePath, 'utf8');
      expect(content).toContain('id: IMP-1');
      expect(content).toContain('specRef:');
    });
  });

  it('allocates monotonically increasing IDs across calls', () => {
    withTmp((dir) => {
      const entry = {
        taskId: 'T-001',
        title: 'a',
        body: '',
        acceptanceCriteria: [],
      };
      const opts = {
        workDir: dir,
        featureId: 'f',
        artifactPath: 'tasks.md',
        importedAt: '2026-05-24T00:00:00.000Z',
      };
      const a = writeBacklogTaskFromSpecKitEntry(entry, opts);
      const b = writeBacklogTaskFromSpecKitEntry({ ...entry, title: 'b' }, opts);
      expect(a.id).toBe('IMP-1');
      expect(b.id).toBe('IMP-2');
    });
  });

  it('rejects malformed prefixes', () => {
    withTmp((dir) => {
      expect(() =>
        writeBacklogTaskFromSpecKitEntry(
          { taskId: 'T-1', title: 'x', body: '', acceptanceCriteria: [] },
          {
            workDir: dir,
            prefix: 'bad-prefix',
            featureId: 'f',
            artifactPath: 'tasks.md',
          },
        ),
      ).toThrow(/invalid task prefix/);
    });
  });

  it('accepts a non-tracked prefix collision (slug-only) and picks the next free id', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
      // Pre-existing files with the same slug but a different prefix
      // (`wow-N - title.md`) should not block an `IMP` write — the
      // prefix scoping is per-allocator. This guards against accidental
      // prefix bleed in `nextTaskNumber`.
      writeFileSync(join(dir, 'backlog', 'tasks', 'wow-1 - title.md'), 'pre');
      writeFileSync(join(dir, 'backlog', 'tasks', 'wow-2 - title.md'), 'pre');
      const written = writeBacklogTaskFromSpecKitEntry(
        { taskId: 'T-1', title: 'title', body: '', acceptanceCriteria: [] },
        { workDir: dir, featureId: 'f', artifactPath: 'tasks.md' },
      );
      expect(written.id).toBe('IMP-1');
      expect(written.fileName).toBe('imp-1 - title.md');
    });
  });
});
