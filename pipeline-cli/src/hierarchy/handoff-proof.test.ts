import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listDecisions } from '../decisions/projection.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { HANDOFF_BEGIN, HANDOFF_END } from './handoff.js';
import {
  appendRotationLog,
  checkHandoffProof,
  escalateUnprovenRotation,
  handoffWrittenSince,
  markRotation,
  resumeBlocks,
  resumeHash,
  rotationLogPath,
  rotationScope,
} from './handoff-proof.js';
import { readRotateRequest, writeRotateRequest } from './rotate-request.js';
import {
  pendingOperatorQuestion,
  readDyingTranscript,
  recordDyingTranscript,
} from './transcript-recall.js';

let tmp: string;
let boardDir: string;
let file: string;
const T0 = new Date('2026-11-26T21:45:28.000Z');
const opts = () => ({ boardDir, now: () => T0, file });

const generated = (hash: string) =>
  [
    HANDOFF_BEGIN,
    `<!-- state-hash: ${hash.repeat(64).slice(0, 64)} -->`,
    '# Handoff',
    HANDOFF_END,
  ].join('\n');
const write = (body: string, mtime: Date) => {
  writeFileSync(file, body);
  utimesSync(file, mtime, mtime);
};
const after = new Date(T0.getTime() + 60_000);
const before = new Date(T0.getTime() - 60_000);

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'handoff-proof-'));
  boardDir = path.join(tmp, '.ai-sdlc', 'dispatch');
  mkdirSync(boardDir, { recursive: true });
  file = path.join(tmp, 'handoff.md');
});
afterEach(() => removeFixtureDir(tmp));

describe('resumeBlocks / resumeHash', () => {
  it('finds RESUME HERE sections outside the generated block only', () => {
    const text = [
      'title',
      HANDOFF_BEGIN,
      '## RESUME HERE inside the markers',
      HANDOFF_END,
      '## Notes',
      'x',
      '## RESUME HERE',
      'open rulings: none',
      '## Later',
    ].join('\n');
    expect(resumeBlocks(text)).toEqual(['## RESUME HERE\nopen rulings: none']);
    expect(resumeHash(text)).toMatch(/^[0-9a-f]{64}$/);
    expect(resumeHash('nothing')).toBeNull();
    expect(resumeHash('## RESUME HERE a\n## RESUME HERE b')).toBeNull();
  });
});

describe('handoffWrittenSince (AISDLC-1448 AC-1)', () => {
  it('an unchanged RESUME block is not proven', () => {
    write(`${generated('a')}\n## RESUME HERE\nold\n`, before);
    const { since } = markRotation('planner', 'planner', opts());
    write(`${generated('a')}\n## RESUME HERE\nold\n`, after);
    expect(handoffWrittenSince('planner', 'planner', since, opts())).toBe(false);
    expect(checkHandoffProof('planner', 'planner', since, opts()).reason).toContain('unchanged');
  });

  it('a regenerated state block only is not proven', () => {
    write(`${generated('a')}\n## RESUME HERE\nold\n`, before);
    const { since } = markRotation('planner', 'planner', opts());
    write(`${generated('b')}\n## RESUME HERE\nold\n`, after);
    expect(handoffWrittenSince('planner', 'planner', since, opts())).toBe(false);
  });

  it('two RESUME blocks are not proven', () => {
    write(`${generated('a')}\n## RESUME HERE\nold\n`, before);
    const { since } = markRotation('planner', 'planner', opts());
    write(`${generated('a')}\n## RESUME HERE\nold\n## RESUME HERE\nnew\n`, after);
    expect(checkHandoffProof('planner', 'planner', since, opts()).reason).toContain('2 RESUME');
  });

  it('a new block written after since is proven', () => {
    write(`${generated('a')}\n## RESUME HERE\nold\n`, before);
    const { since } = markRotation('planner', 'planner', opts());
    write(`${generated('a')}\n## RESUME HERE\nnew: OQ-3 answered B\n`, after);
    expect(handoffWrittenSince('planner', 'planner', since, opts())).toBe(true);
  });

  it('a new block whose file is not newer than since is not proven', () => {
    write('no block yet\n', before);
    const { since, resumeHash: base } = markRotation('planner', 'planner', opts());
    expect(base).toBeNull();
    write('## RESUME HERE\nnew\n', before);
    expect(checkHandoffProof('planner', 'planner', since, opts()).reason).toContain('not modified');
  });

  it('refuses without a request, a missing file, or an invalid since', () => {
    expect(checkHandoffProof('planner', 'planner', T0.toISOString(), opts()).reason).toContain(
      'no rotation request',
    );
    writeRotateRequest(boardDir, 'planner', T0);
    expect(checkHandoffProof('planner', 'planner', T0.toISOString(), opts()).reason).toContain(
      'no rotation request',
    );
    writeRotateRequest(boardDir, 'planner', T0, null);
    expect(checkHandoffProof('planner', 'planner', T0.toISOString(), opts()).reason).toContain(
      'does not exist',
    );
    expect(checkHandoffProof('planner', 'planner', 'nope', opts()).reason).toContain('invalid');
  });

  it('markRotation keeps an unsatisfied request and replaces a satisfied one', () => {
    write('## RESUME HERE\nold\n', before);
    const first = markRotation('executor', 'ex-1', opts());
    const later = { ...opts(), now: () => after };
    expect(markRotation('executor', 'ex-1', later).since).toBe(first.since);
    write('## RESUME HERE\nnew\n', after);
    const next = markRotation('executor', 'ex-1', later);
    expect(next.since).toBe(after.toISOString());
    expect(readRotateRequest(boardDir, 'ex-1')?.resumeHash).toBe(next.resumeHash);
  });
});

describe('unproven rotation alerts (AISDLC-1448)', () => {
  it('appends to rotation.log under the board', () => {
    appendRotationLog(boardDir, T0, 'handoff unproven; not clearing planner');
    expect(readFileSync(rotationLogPath(boardDir), 'utf-8')).toBe(
      `${T0.toISOString()} handoff unproven; not clearing planner\n`,
    );
  });

  it('files one session-rotation escalation and reuses it', () => {
    const id = escalateUnprovenRotation(tmp, 'proj-planner', 'unchanged', T0);
    expect(escalateUnprovenRotation(tmp, 'proj-planner', 'unchanged', T0)).toBe(id);
    const open = listDecisions({ workDir: tmp }).decisions.filter(
      (d) => d.metadata.scope === rotationScope('proj-planner'),
    );
    expect(open).toHaveLength(1);
  });
});

describe('pending operator question and dying transcript (AISDLC-1448)', () => {
  const rec = (role: string, content: unknown) =>
    JSON.stringify({ type: role, message: { role, content } });

  it('is pending while an AskUserQuestion has no tool_result', () => {
    const t = path.join(tmp, 't.jsonl');
    const ask = rec('assistant', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion' }]);
    writeFileSync(t, `${ask}\nnot json tool_use\n`);
    expect(pendingOperatorQuestion(t)).toBe(true);
    writeFileSync(t, `${ask}\n${rec('user', [{ type: 'tool_result', tool_use_id: 'q1' }])}\n`);
    expect(pendingOperatorQuestion(t)).toBe(false);
    expect(pendingOperatorQuestion(undefined)).toBe(false);
    expect(pendingOperatorQuestion(path.join(tmp, 'missing.jsonl'))).toBe(false);
  });

  it('records the dying transcript and reads it back', () => {
    expect(recordDyingTranscript(boardDir, 'planner', {}, T0)).toBeUndefined();
    recordDyingTranscript(boardDir, 'planner', { file: '/t/old.jsonl', sessionId: 'old' }, T0);
    expect(readDyingTranscript(boardDir, 'planner')).toEqual({
      file: '/t/old.jsonl',
      sessionId: 'old',
      at: T0.toISOString(),
    });
    expect(readDyingTranscript(boardDir, 'nobody')).toBeUndefined();
  });
});
