/**
 * Tests for the operator-question gate replay (AISDLC-1443, AC 8).
 * Run with: node --test scripts/question-gate-replay.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askCalls,
  defaultTranscriptDir,
  main,
  readTranscript,
  replay,
  roleFromAgentName,
} from './question-gate-replay.mjs';

const NOW = Date.parse('2026-11-27T00:00:00Z');
const prompt = (text) => ({ type: 'user', message: { content: text } });
const skill = (name) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'sk', name: 'Skill', input: { skill: name } }] },
});
const askEntry = (id, question, ts = '2026-11-26T10:00:00Z', extra = {}) => ({
  type: 'assistant',
  timestamp: ts,
  sessionId: 's1',
  message: {
    content: [
      {
        type: 'tool_use',
        id,
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question,
              header: 'Pick',
              options: [
                { label: 'Option one', description: 'The first way.' },
                { label: 'Option two', description: 'The second way.' },
              ],
            },
          ],
        },
      },
    ],
  },
  ...extra,
});

const TRANSCRIPT = [
  { type: 'agent-name', agentName: 'ai-sdlc-planner' },
  prompt('first'),
  skill('ai-sdlc:decision-rubric'),
  askEntry('a1', 'Framed question?'),
  prompt('second'),
  askEntry('a2', 'Unframed question?'),
  askEntry('old', 'Too old?', '2026-09-01T00:00:00Z'),
  askEntry('side', 'Sidechain?', '2026-11-26T10:00:00Z', { isSidechain: true }),
  askEntry('oq', 'Resolve OQ-4 now?'),
  { type: 'agent-name', agentName: 'ai-sdlc-executor-aisdlc-1' },
  askEntry('ex', 'Executor question?'),
];

describe('question-gate replay', () => {
  it('maps hierarchy session names to roles', () => {
    assert.equal(roleFromAgentName('ai-sdlc-executor-aisdlc-1415'), 'executor');
    assert.equal(roleFromAgentName('ai-sdlc-operator-dispatch'), 'operator-dispatch');
    assert.equal(roleFromAgentName('ai-sdlc-planner'), 'planner');
    assert.equal(roleFromAgentName('someone'), null);
    assert.equal(roleFromAgentName(undefined), null);
  });

  it('collects main-thread calls since the cutoff with their role and turn', () => {
    const calls = askCalls(TRANSCRIPT, NOW - 30 * 86400000);
    assert.deepEqual(
      calls.map((c) => [c.id, c.role]),
      [
        ['a1', 'planner'],
        ['a2', 'planner'],
        ['oq', 'planner'],
        ['ex', 'executor'],
      ],
    );
    assert.equal(calls[0].turn.length, 2);
  });

  it('tallies would-deny per check, deduplicating repeated calls', () => {
    const calls = askCalls(TRANSCRIPT, NOW - 30 * 86400000);
    const { summary, rubricDenied } = replay([...calls, calls[0]]);
    assert.equal(summary.total, 4);
    assert.deepEqual(summary.wouldDeny, {
      unattended: 1,
      'already-decided': 0,
      'own-class': 0,
      rubric: 2,
    });
    assert.equal(summary.openQuestionExempt, 1);
    assert.equal(summary.rubricAllowedBy['decision-rubric'], 1);
    assert.deepEqual(
      rubricDenied.map((d) => d.id),
      ['a2', 'oq'],
    );
    assert.equal(rubricDenied[0].questions[0].options[0].label, 'Option one');
  });

  it('counts shadow would-denies from a judge', () => {
    const judge = () => ({
      duplicate: {
        mode: 'shadow',
        outcome: 'abstain',
        shadow: { outcome: 'act', decision: { duplicateOf: 'DEC-1' } },
        match: { id: 'DEC-1', option: 'a', summary: 's' },
      },
    });
    const { summary } = replay(askCalls(TRANSCRIPT.slice(0, 4)), { judge });
    assert.equal(summary.wouldDeny['already-decided'], 1);
  });

  it('main reads a transcripts directory and writes the denied set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgate-replay-'));
    const out = join(dir, 'denied.jsonl');
    const writes = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (t) => (writes.push(String(t)), true);
    try {
      writeFileSync(
        join(dir, 'a.jsonl'),
        TRANSCRIPT.map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n',
      );
      writeFileSync(join(dir, 'b.jsonl'), '{"type":"user"}\n');
      writeFileSync(join(dir, 'old.jsonl'), TRANSCRIPT.map((e) => JSON.stringify(e)).join('\n'));
      utimesSync(join(dir, 'old.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));
      writeFileSync(join(dir, 'notes.txt'), '');
      assert.equal(await main(['--dir', dir, '--days', '30', '--denied-out', out], NOW), 0);
      const report = JSON.parse(writes.join(''));
      assert.equal(report.total, 4);
      assert.equal(readFileSync(out, 'utf-8').trim().split('\n').length, 2);
      assert.equal(readTranscript(join(dir, 'a.jsonl')).length, TRANSCRIPT.length);
      await assert.rejects(main(['--dir', join(dir, 'missing')], NOW), /no transcripts directory/);
      await assert.rejects(main(['--bogus'], NOW), /unknown argument/);
      await assert.rejects(main(['--days', '0'], NOW), /--days must be positive/);
    } finally {
      process.stdout.write = orig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives the Claude Code transcripts directory from the checkout path', () => {
    assert.equal(
      defaultTranscriptDir('/Users/x/dev/ai-sdlc', '/home'),
      '/home/.claude/projects/-Users-x-dev-ai-sdlc',
    );
  });
});
