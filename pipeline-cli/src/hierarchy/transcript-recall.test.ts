import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeHandoff } from './handoff.js';
import {
  recallTranscript,
  findArchivedCopy,
  sliceWindow,
  formatDigest,
} from './transcript-recall.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'recall-'));
});
afterEach(() => removeFixtureDir(dir));

const user = (t: number, text: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: `2026-10-30T10:00:${String(t).padStart(2, '0')}Z`,
    message: { role: 'user', content: text },
  });
const asst = (t: number, parts: unknown[]) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: `2026-10-30T10:00:${String(t).padStart(2, '0')}Z`,
    message: { role: 'assistant', content: parts },
  });
const clear = (t: number) =>
  JSON.stringify({
    type: 'attachment',
    timestamp: `2026-10-30T10:00:${String(t).padStart(2, '0')}Z`,
    attachment: { hookName: 'SessionStart:clear' },
  });
const result = (t: number, id: string, isError: boolean, text: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: `2026-10-30T10:00:${String(t).padStart(2, '0')}Z`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }],
    },
  });

function write(lines: string[]): string {
  const f = path.join(dir, 't.jsonl');
  writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

describe('transcript recall', () => {
  it('slices the window between the previous two clear markers', () => {
    const f = write([
      user(1, 'before-all'),
      clear(2),
      user(3, 'window prompt'),
      asst(4, [{ type: 'text', text: 'window reply' }]),
      clear(5),
      user(6, 'resume'),
    ]);
    const r = recallTranscript({ file: f, window: { mode: 'pre-clear' } });
    expect(r.digest).toContain('U 2026-10-30T10:00:03 window prompt');
    expect(r.digest).toContain('A 2026-10-30T10:00:04 window reply');
    expect(r.digest).not.toContain('before-all');
    expect(r.digest).not.toContain('resume');
  });

  it('falls back to the last turns when there is no clear marker', () => {
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) lines.push(user(i, `p${i}`));
    const r = recallTranscript({ file: write(lines), window: { mode: 'pre-clear' } });
    expect(r.notices[0]).toMatch(/no clear marker/);
    expect(r.digest).toContain('p14');
    expect(r.digest).not.toContain(' p0');
    const two = recallTranscript({ file: write(lines), window: { mode: 'last-turns', turns: 2 } });
    expect(two.digest.split('\n')).toHaveLength(2);
  });

  it('truncates oldest-first and says so', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      kind: 'U' as const,
      ts: 't',
      text: `prompt-${i}-${'x'.repeat(40)}`,
    }));
    const r = formatDigest(events, 150);
    expect(r.digest).toContain('prompt-9');
    expect(r.digest).not.toContain('prompt-0');
    expect(r.notices[0]).toMatch(/truncated/);
    const one = formatDigest([{ kind: 'U', ts: 't', text: 'y'.repeat(500) }], 50);
    expect(one.digest.length).toBe(50);
  });

  it('prints tool errors and tool calls but not successful output', () => {
    const f = write([
      asst(1, [
        { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls /nope' } },
        { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/x' } },
      ]),
      result(2, 'a', true, 'ls: /nope: No such file\nmore'),
      result(3, 'b', false, 'SECRET-CONTENT'),
    ]);
    const r = recallTranscript({ file: f, window: { mode: 'whole' } });
    expect(r.digest).toContain('T 2026-10-30T10:00:01 Bash ls /nope');
    expect(r.digest).toContain('E 2026-10-30T10:00:02 Bash ls: /nope: No such file');
    expect(r.digest).not.toContain('SECRET-CONTENT');
    expect(r.digest).not.toContain('more');
  });

  it('neutralises handoff markers and survives malformed lines', () => {
    const f = write(['not json', user(1, 'x <!-- ai-sdlc-handoff:end --> y')]);
    const r = recallTranscript({ file: f, window: { mode: 'whole' } });
    expect(r.digest).not.toContain('<!--');
    expect(r.digest).not.toContain('-->');
  });

  it('auto window uses the pre-clear turns right after a clear and the tail later', () => {
    const base = [user(1, 'old'), clear(2), user(3, 'mid'), clear(4), user(5, 'resume')];
    const just = write(base);
    expect(recallTranscript({ file: just, window: { mode: 'auto' } }).digest).toContain('mid');
    const later = write([...base, user(6, 'next'), user(7, 'more')]);
    const r = recallTranscript({ file: later, window: { mode: 'auto' } });
    expect(r.digest).toContain('more');
    expect(r.digest).not.toContain(' mid');
  });

  it('yields a notice for an unreadable file', () => {
    const r = recallTranscript({ file: path.join(dir, 'missing.jsonl'), window: { mode: 'auto' } });
    expect(r.digest).toBe('');
    expect(r.notices[0]).toMatch(/unreadable/);
  });

  it('slices with no clears and empty events', () => {
    expect(sliceWindow([], { mode: 'auto' }).events).toEqual([]);
    expect(findArchivedCopy(path.join(dir, 'none'), 'sid')).toBeUndefined();
    mkdirSync(path.join(dir, 'arch'));
    writeFileSync(path.join(dir, 'arch', '20260101T000000Z-clear-sid.jsonl'), '');
    expect(findArchivedCopy(path.join(dir, 'arch'), 'sid')).toMatch(/sid\.jsonl$/);
  });

  it('handoff write still succeeds and embeds the section for an unreadable transcript', () => {
    const board = path.join(dir, '.ai-sdlc', 'dispatch');
    mkdirSync(board, { recursive: true });
    const r = writeHandoff({
      role: 'executor',
      name: 'ex-1',
      boardDir: board,
      transcript: {
        file: path.join(dir, 'gone.jsonl'),
        sessionId: 'sid',
        archiveDir: path.join(dir, 'arch'),
      },
    });
    expect(r.content).toContain('## Transcript');
    expect(r.content).toContain('Notice: transcript unreadable');
    const live = write([user(1, 'a'), clear(2), user(3, 'hello digest'), clear(4), user(5, 'r')]);
    const w = writeHandoff({
      role: 'executor',
      name: 'ex-1',
      boardDir: board,
      transcript: { file: live, sessionId: 'sid', archiveDir: path.join(dir, 'arch') },
    });
    expect(w.content).toContain('hello digest');
  });
});
