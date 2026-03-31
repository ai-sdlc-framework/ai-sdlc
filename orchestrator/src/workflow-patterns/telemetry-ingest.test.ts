import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readToolSequenceJSONL,
  readSessionMetaFiles,
  sessionMetaToEvents,
  categorizeAction,
} from './telemetry-ingest.js';

const TEST_DIR = join(tmpdir(), 'ai-sdlc-telemetry-test-' + Date.now());

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe('readToolSequenceJSONL', () => {
  it('reads valid JSONL file', () => {
    setup();
    const filePath = join(TEST_DIR, 'test.jsonl');
    const lines = [
      JSON.stringify({
        ts: '2026-03-27T10:00:00Z',
        sid: 'session-1',
        tool: 'Bash',
        action: 'pnpm test',
        project: '/repo',
      }),
      JSON.stringify({
        ts: '2026-03-27T10:00:01Z',
        sid: 'session-1',
        tool: 'Read',
        action: 'read:.ts',
        project: '/repo',
      }),
    ];
    writeFileSync(filePath, lines.join('\n') + '\n');

    const events = readToolSequenceJSONL(filePath);

    expect(events).toHaveLength(2);
    expect(events[0].sessionId).toBe('session-1');
    expect(events[0].toolName).toBe('Bash');
    expect(events[0].actionCanonical).toBe('pnpm test');
    expect(events[1].toolName).toBe('Read');
    cleanup();
  });

  it('returns empty for non-existent file', () => {
    expect(readToolSequenceJSONL('/nonexistent/file.jsonl')).toEqual([]);
  });

  it('skips malformed lines', () => {
    setup();
    const filePath = join(TEST_DIR, 'malformed.jsonl');
    writeFileSync(
      filePath,
      'not json\n{"ts":"2026-01-01","sid":"s1","tool":"Bash","action":"echo","project":"/"}\n\n',
    );

    const events = readToolSequenceJSONL(filePath);

    expect(events).toHaveLength(1);
    expect(events[0].toolName).toBe('Bash');
    cleanup();
  });

  it('handles empty file', () => {
    setup();
    const filePath = join(TEST_DIR, 'empty.jsonl');
    writeFileSync(filePath, '');

    expect(readToolSequenceJSONL(filePath)).toEqual([]);
    cleanup();
  });
});

describe('readSessionMetaFiles', () => {
  it('reads session-meta JSON files', () => {
    setup();
    const metaDir = join(TEST_DIR, 'session-meta');
    mkdirSync(metaDir, { recursive: true });

    const meta = {
      session_id: 'abc-123',
      project_path: '/repo',
      start_time: '2026-03-27T10:00:00Z',
      duration_minutes: 30,
      user_message_count: 5,
      assistant_message_count: 20,
      tool_counts: { Bash: 10, Read: 15, Edit: 5 },
      git_commits: 2,
      git_pushes: 1,
      first_prompt: 'Fix the bug',
      tool_errors: 1,
      lines_added: 50,
      files_modified: 3,
    };
    writeFileSync(join(metaDir, 'abc-123.json'), JSON.stringify(meta));

    const sessions = readSessionMetaFiles(TEST_DIR);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe('abc-123');
    expect(sessions[0].tool_counts.Bash).toBe(10);
    cleanup();
  });

  it('returns empty for non-existent directory', () => {
    expect(readSessionMetaFiles('/nonexistent/dir')).toEqual([]);
  });

  it('skips invalid JSON files', () => {
    setup();
    const metaDir = join(TEST_DIR, 'session-meta');
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, 'bad.json'), 'not json');

    expect(readSessionMetaFiles(TEST_DIR)).toEqual([]);
    cleanup();
  });
});

describe('sessionMetaToEvents', () => {
  it('converts tool_counts to synthetic events', () => {
    const meta = {
      session_id: 'sess-1',
      project_path: '/repo',
      start_time: '2026-03-27T10:00:00Z',
      duration_minutes: 10,
      user_message_count: 3,
      assistant_message_count: 10,
      tool_counts: { Bash: 2, Read: 3 },
      git_commits: 0,
      git_pushes: 0,
      first_prompt: 'test',
      tool_errors: 0,
      lines_added: 0,
      files_modified: 0,
    };

    const events = sessionMetaToEvents(meta);

    expect(events).toHaveLength(5); // 2 Bash + 3 Read
    expect(events.filter((e) => e.toolName === 'Bash')).toHaveLength(2);
    expect(events.filter((e) => e.toolName === 'Read')).toHaveLength(3);
    expect(events[0].sessionId).toBe('sess-1');
  });
});

describe('categorizeAction', () => {
  it('categorizes Read as read', () => {
    expect(categorizeAction('Read', 'read:.ts')).toBe('read');
  });

  it('categorizes Edit as write', () => {
    expect(categorizeAction('Edit', 'edit:.ts')).toBe('write');
  });

  it('categorizes Write as write', () => {
    expect(categorizeAction('Write', 'write:.ts')).toBe('write');
  });

  it('categorizes pnpm test as test', () => {
    expect(categorizeAction('Bash', 'pnpm test')).toBe('test');
  });

  it('categorizes vitest as test', () => {
    expect(categorizeAction('Bash', 'vitest run')).toBe('test');
  });

  it('categorizes pnpm build as build', () => {
    expect(categorizeAction('Bash', 'pnpm build')).toBe('build');
  });

  it('categorizes tsc as build', () => {
    expect(categorizeAction('Bash', 'tsc --noEmit')).toBe('build');
  });

  it('categorizes git commands as git', () => {
    expect(categorizeAction('Bash', 'git commit -m "fix"')).toBe('git');
    expect(categorizeAction('Bash', 'gh pr create')).toBe('git');
  });

  it('categorizes Grep as search', () => {
    expect(categorizeAction('Grep', 'grep:pattern')).toBe('search');
  });

  it('categorizes Glob as search', () => {
    expect(categorizeAction('Glob', 'glob:**/*.ts')).toBe('search');
  });

  it('categorizes unknown as other', () => {
    expect(categorizeAction('Agent', 'explore codebase')).toBe('other');
  });
});
