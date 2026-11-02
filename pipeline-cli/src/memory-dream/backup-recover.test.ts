import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupMemory, memoryBackupHint, repoIdFor } from './backup.js';
import { recoverFromTranscripts } from './recover.js';
import { applyDream } from './apply.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'mem1131-'));

describe('backupMemory', () => {
  it('copies daily, skips same day, keeps fourteen', () => {
    const home = tmp();
    const proj = tmp();
    const mem = join(proj, 'memory');
    mkdirSync(mem);
    writeFileSync(join(mem, 'MEMORY.md'), '- [a](a.md) - x\n');
    expect(
      backupMemory({
        memoryDir: mem,
        projectDir: proj,
        home,
        now: new Date('2026-01-01T00:00:00Z'),
      }).status,
    ).toBe('copied');
    expect(
      backupMemory({
        memoryDir: mem,
        projectDir: proj,
        home,
        now: new Date('2026-01-01T09:00:00Z'),
      }).status,
    ).toBe('already-today');
    for (let d = 2; d <= 20; d++) {
      backupMemory({ memoryDir: mem, projectDir: proj, home, now: new Date(Date.UTC(2026, 0, d)) });
    }
    const root = join(home, '.ai-sdlc', 'memory-backups', repoIdFor(proj));
    const dirs = readdirSync(root).sort();
    expect(dirs).toHaveLength(14);
    expect(dirs[0]).toBe('2026-01-07');
    expect(readFileSync(join(root, '2026-01-20', 'MEMORY.md'), 'utf-8')).toContain('a.md');
  });

  it('skips when there is no memory folder', () => {
    expect(
      backupMemory({
        memoryDir: join(tmp(), 'none'),
        projectDir: tmp(),
        home: tmp(),
        now: new Date(),
      }).status,
    ).toBe('no-memory');
  });

  it('hints only when MEMORY.md is missing and a backup exists (null otherwise)', () => {
    const home = tmp();
    const proj = tmp();
    const mem = join(proj, 'memory');
    expect(memoryBackupHint({ memoryDir: mem, projectDir: proj, home })).toBeNull();
    mkdirSync(mem);
    writeFileSync(join(mem, 'MEMORY.md'), 'x\n');
    backupMemory({ memoryDir: mem, projectDir: proj, home, now: new Date('2026-02-02T00:00:00Z') });
    expect(memoryBackupHint({ memoryDir: mem, projectDir: proj, home })).toBeNull();
    const empty = join(proj, 'memory2');
    mkdirSync(empty);
    expect(memoryBackupHint({ memoryDir: empty, projectDir: proj, home })).toContain('missing');
  });

  it('hints with the newest backup path after MEMORY.md is lost', () => {
    const home = tmp();
    const proj = tmp();
    const mem = join(proj, 'memory');
    mkdirSync(mem);
    writeFileSync(join(mem, 'MEMORY.md'), 'x\n');
    backupMemory({ memoryDir: mem, projectDir: proj, home, now: new Date('2026-02-02T00:00:00Z') });
    const gone = join(proj, 'gone');
    // same project, different (empty) memory dir
    const hint = memoryBackupHint({ memoryDir: gone, projectDir: proj, home });
    expect(hint).toContain('2026-02-02');
    expect(hint).toContain('recover --from-transcripts');
  });
});

const rec = (content: unknown[]): string => JSON.stringify({ message: { content } });

describe('recoverFromTranscripts', () => {
  it('replays Write, Edit and Read and reports missing bodies', () => {
    const projects = tmp();
    const mem = join(tmp(), 'memory');
    const P = '/x/.claude/memory/';
    const lines = [
      rec([
        {
          type: 'tool_use',
          name: 'Write',
          id: '1',
          input: { file_path: `${P}a.md`, content: 'hello world' },
        },
      ]),
      rec([
        {
          type: 'tool_use',
          name: 'Edit',
          id: '2',
          input: { file_path: `${P}a.md`, old_string: 'world', new_string: 'there' },
        },
      ]),
      rec([
        {
          type: 'tool_use',
          name: 'Edit',
          id: '2b',
          input: { file_path: `${P}a.md`, old_string: 'zzz', new_string: 'q' },
        },
      ]),
      rec([
        {
          type: 'tool_use',
          name: 'Edit',
          id: '2c',
          input: { file_path: `${P}a.md`, old_string: 'l', new_string: 'L', replace_all: true },
        },
      ]),
      rec([{ type: 'tool_use', name: 'Read', id: '3', input: { file_path: `${P}b.md` } }]),
      rec([
        {
          type: 'tool_result',
          tool_use_id: '3',
          content: [{ type: 'text', text: '     1\tline one\n     2\tline two' }],
        },
      ]),
      rec([{ type: 'tool_use', name: 'Read', id: '4', input: { file_path: `${P}MEMORY.md` } }]),
      rec([
        {
          type: 'tool_result',
          tool_use_id: '4',
          content: '1\t- [a](a.md) - x\n2\t- [b](b.md) - y\n3\t- [c](c.md) - z',
        },
      ]),
      rec([
        { type: 'tool_use', name: 'Read', id: '5', input: { file_path: `${P}d.md`, limit: 3 } },
      ]),
      rec([
        {
          type: 'tool_use',
          name: 'Write',
          id: '6',
          input: { file_path: '/x/other.md', content: 'no' },
        },
      ]),
      'not json',
      JSON.stringify({ message: { content: 'text' } }),
    ];
    writeFileSync(join(projects, 's.jsonl'), lines.join('\n'));
    const r = recoverFromTranscripts({
      projectsDir: projects,
      memoryDir: mem,
      now: new Date('2026-03-03T00:00:00Z'),
    });
    expect(r.recovered).toEqual(['a.md', 'b.md']);
    expect(r.missingBodies).toEqual(['c.md']);
    expect(readFileSync(join(r.outputDir, 'a.md'), 'utf-8')).toBe('heLLo there');
    expect(readFileSync(join(r.outputDir, 'b.md'), 'utf-8')).toBe('line one\nline two');
    expect(readFileSync(`${r.outputDir}.report.md`, 'utf-8')).toContain('c.md');
    const applied = applyDream({ outputDir: r.outputDir });
    expect(applied.liveDir).toBe(mem);
    expect(existsSync(join(mem, 'a.md'))).toBe(true);
  });

  it('carries live notes and throws on a missing folder', () => {
    const projects = tmp();
    const mem = join(tmp(), 'memory');
    mkdirSync(mem);
    writeFileSync(join(mem, 'live.md'), 'live');
    writeFileSync(join(mem, 'MEMORY.md'), '- [live](live.md) - l\n- [gone](gone.md) - g\n');
    const r = recoverFromTranscripts({ projectsDir: projects, memoryDir: mem });
    expect(r.recovered).toEqual(['live.md']);
    expect(r.missingBodies).toEqual(['gone.md']);
    expect(() =>
      recoverFromTranscripts({ projectsDir: join(projects, 'nope'), memoryDir: mem }),
    ).toThrow(/not found/);
  });
});

describe('cli commands', () => {
  it('cmdRecover and cmdBackup print summaries', async () => {
    const { cmdRecover, cmdBackup } = await import('../cli/memory-dream.js');
    const projects = tmp();
    const mem = join(tmp(), 'memory');
    mkdirSync(mem);
    writeFileSync(join(mem, 'MEMORY.md'), '- [g](g.md) - g\n');
    const out: string[] = [];
    cmdRecover({ fromTranscripts: projects, dir: mem }, { out: (l) => out.push(l) });
    expect(out.join('\n')).toContain('missing: g.md');
    const out2: string[] = [];
    cmdBackup({ dir: join(tmp(), 'none') }, { out: (l) => out2.push(l) });
    expect(out2[0]).toContain('skipped');
  });
});
