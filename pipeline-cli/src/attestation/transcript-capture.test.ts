/**
 * transcript-capture.test.ts — RFC-0042 Phase 1 hermetic tests.
 *
 * Validates:
 *   - JSONL event validation (isValidTranscriptEvent)
 *   - File parsing (parseTranscriptFile) — happy path + malformed lines
 *   - Discovery (listTranscripts) — with + without filterTaskId
 *   - Table formatting (formatTranscriptTable)
 *
 * Uses a tmp directory with fixture JSONL files; no actual subagent dispatch.
 * All filesystem I/O is against the real FS (tmp dir) for reliability.
 *
 * @see pipeline-cli/src/attestation/transcript-capture.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatTranscriptTable,
  isValidTranscriptEvent,
  listTranscripts,
  parseTranscriptFile,
  resolveTranscriptsDir,
  type TranscriptEvent,
} from './transcript-capture.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build a minimal valid TranscriptEvent. */
function makeEvent(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    role: 'user',
    content: 'test content',
    timestamp: '2026-05-21T10:00:00.000Z',
    ...overrides,
  };
}

/** Serialize an event (or arbitrary object) to a JSONL line. */
function toJsonlLine(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXTURE_PROMPT_EVENT: TranscriptEvent = {
  role: 'user',
  content: '[transcript-init] code-reviewer prompt received for task AISDLC-383.1',
  timestamp: '2026-05-21T10:00:00.000Z',
  event: 'prompt-received',
};

const FIXTURE_RESPONSE_EVENT: TranscriptEvent = {
  role: 'assistant',
  content: 'No critical findings. Code quality is good overall.',
  timestamp: '2026-05-21T10:01:30.000Z',
  event: 'verdict-formed',
};

const FIXTURE_TOOL_EVENT: TranscriptEvent = {
  role: 'tool',
  content: 'Read file: src/foo.ts',
  timestamp: '2026-05-21T10:00:45.000Z',
  event: 'tool-call',
  toolName: 'Read',
};

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'transcript-capture-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── isValidTranscriptEvent ────────────────────────────────────────────────────

describe('isValidTranscriptEvent', () => {
  it('accepts a minimal valid user event', () => {
    expect(isValidTranscriptEvent(makeEvent({ role: 'user' }))).toBe(true);
  });

  it('accepts a valid assistant event', () => {
    expect(isValidTranscriptEvent(makeEvent({ role: 'assistant' }))).toBe(true);
  });

  it('accepts a valid tool event', () => {
    expect(isValidTranscriptEvent(makeEvent({ role: 'tool' }))).toBe(true);
  });

  it('accepts a valid tool_result event', () => {
    expect(isValidTranscriptEvent(makeEvent({ role: 'tool_result' }))).toBe(true);
  });

  it('accepts an event with optional fields', () => {
    const event = makeEvent({
      role: 'assistant',
      event: 'verdict-formed',
      harness: 'codex',
    });
    expect(isValidTranscriptEvent(event)).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidTranscriptEvent(null)).toBe(false);
  });

  it('rejects a string', () => {
    expect(isValidTranscriptEvent('not an object')).toBe(false);
  });

  it('rejects missing role', () => {
    const { role: _, ...noRole } = makeEvent();
    expect(isValidTranscriptEvent(noRole)).toBe(false);
  });

  it('rejects invalid role value', () => {
    expect(isValidTranscriptEvent({ ...makeEvent(), role: 'system' })).toBe(false);
  });

  it('rejects missing content', () => {
    const { content: _, ...noContent } = makeEvent();
    expect(isValidTranscriptEvent(noContent)).toBe(false);
  });

  it('rejects non-string content', () => {
    expect(isValidTranscriptEvent({ ...makeEvent(), content: 42 })).toBe(false);
  });

  it('rejects missing timestamp', () => {
    const { timestamp: _, ...noTs } = makeEvent();
    expect(isValidTranscriptEvent(noTs)).toBe(false);
  });

  it('rejects invalid timestamp (not ISO-8601)', () => {
    expect(isValidTranscriptEvent({ ...makeEvent(), timestamp: 'not-a-date' })).toBe(false);
  });

  it('rejects numeric timestamp', () => {
    expect(isValidTranscriptEvent({ ...makeEvent(), timestamp: 1716278400000 })).toBe(false);
  });
});

// ── parseTranscriptFile ───────────────────────────────────────────────────────

describe('parseTranscriptFile', () => {
  it('parses a well-formed JSONL file with multiple events', () => {
    const filePath = join(tmpRoot, 'code-reviewer.jsonl');
    writeFileSync(
      filePath,
      [
        toJsonlLine(FIXTURE_PROMPT_EVENT),
        toJsonlLine(FIXTURE_TOOL_EVENT),
        toJsonlLine(FIXTURE_RESPONSE_EVENT),
      ].join(''),
    );

    const { events, malformedLines } = parseTranscriptFile(filePath);
    expect(events).toHaveLength(3);
    expect(malformedLines).toBe(0);
    expect(events[0]!.role).toBe('user');
    expect(events[0]!.event).toBe('prompt-received');
    expect(events[2]!.role).toBe('assistant');
    expect(events[2]!.event).toBe('verdict-formed');
  });

  it('skips blank lines without counting them as malformed', () => {
    const filePath = join(tmpRoot, 'test-reviewer.jsonl');
    writeFileSync(
      filePath,
      '\n' +
        toJsonlLine(FIXTURE_PROMPT_EVENT) +
        '\n\n' +
        toJsonlLine(FIXTURE_RESPONSE_EVENT) +
        '\n',
    );

    const { events, malformedLines } = parseTranscriptFile(filePath);
    expect(events).toHaveLength(2);
    expect(malformedLines).toBe(0);
  });

  it('counts lines with invalid JSON as malformed', () => {
    const filePath = join(tmpRoot, 'security-reviewer.jsonl');
    writeFileSync(
      filePath,
      toJsonlLine(FIXTURE_PROMPT_EVENT) + 'not valid json\n' + toJsonlLine(FIXTURE_RESPONSE_EVENT),
    );

    const { events, malformedLines } = parseTranscriptFile(filePath);
    expect(events).toHaveLength(2);
    expect(malformedLines).toBe(1);
  });

  it('counts lines with valid JSON but invalid event shape as malformed', () => {
    const filePath = join(tmpRoot, 'code-reviewer.jsonl');
    const badEvent = { foo: 'bar' }; // missing required fields
    writeFileSync(filePath, toJsonlLine(FIXTURE_PROMPT_EVENT) + toJsonlLine(badEvent));

    const { events, malformedLines } = parseTranscriptFile(filePath);
    expect(events).toHaveLength(1);
    expect(malformedLines).toBe(1);
  });

  it('handles a file with only blank lines (zero events, zero malformed)', () => {
    const filePath = join(tmpRoot, 'empty.jsonl');
    writeFileSync(filePath, '\n\n\n');

    const { events, malformedLines } = parseTranscriptFile(filePath);
    expect(events).toHaveLength(0);
    expect(malformedLines).toBe(0);
  });

  it('missing-prompt edge case: still parses assistant events correctly', () => {
    // The first event is an assistant turn (no prompt precedes it — edge case for
    // transcripts that started capture mid-conversation).
    const filePath = join(tmpRoot, 'partial.jsonl');
    writeFileSync(filePath, toJsonlLine(FIXTURE_RESPONSE_EVENT));

    const { events, malformedLines } = parseTranscriptFile(filePath);
    expect(events).toHaveLength(1);
    expect(events[0]!.role).toBe('assistant');
    expect(malformedLines).toBe(0);
  });

  it('preserves event metadata fields (event, toolName, harness)', () => {
    const filePath = join(tmpRoot, 'codex.jsonl');
    const codexEvent: TranscriptEvent = {
      role: 'assistant',
      content: 'Codex review completed.',
      timestamp: '2026-05-21T11:00:00.000Z',
      event: 'verdict-formed',
      harness: 'codex',
    };
    writeFileSync(filePath, toJsonlLine(codexEvent));

    const { events } = parseTranscriptFile(filePath);
    expect(events[0]!.harness).toBe('codex');
    expect(events[0]!.event).toBe('verdict-formed');
  });
});

// ── resolveTranscriptsDir ─────────────────────────────────────────────────────

describe('resolveTranscriptsDir', () => {
  it('returns <repoRoot>/.ai-sdlc/transcripts', () => {
    const dir = resolveTranscriptsDir('/repo/root');
    expect(dir).toBe('/repo/root/.ai-sdlc/transcripts');
  });
});

// ── listTranscripts ───────────────────────────────────────────────────────────

describe('listTranscripts', () => {
  function makeTranscriptDir(repoRoot: string, taskId: string, reviewer: string): string {
    const dir = join(repoRoot, '.ai-sdlc', 'transcripts', taskId);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${reviewer}.jsonl`);
    writeFileSync(
      filePath,
      toJsonlLine(FIXTURE_PROMPT_EVENT) + toJsonlLine(FIXTURE_RESPONSE_EVENT),
    );
    return filePath;
  }

  it('returns empty array when transcripts directory does not exist', () => {
    const result = listTranscripts(tmpRoot);
    expect(result).toEqual([]);
  });

  it('returns empty array when transcripts directory exists but is empty', () => {
    mkdirSync(join(tmpRoot, '.ai-sdlc', 'transcripts'), { recursive: true });
    const result = listTranscripts(tmpRoot);
    expect(result).toEqual([]);
  });

  it('lists a single transcript file with correct metadata', () => {
    makeTranscriptDir(tmpRoot, 'aisdlc-383.1', 'code-reviewer');

    const result = listTranscripts(tmpRoot);
    expect(result).toHaveLength(1);
    expect(result[0]!.taskId).toBe('aisdlc-383.1');
    expect(result[0]!.reviewerName).toBe('code-reviewer');
    expect(result[0]!.eventCount).toBe(2);
    expect(result[0]!.byteSize).toBeGreaterThan(0);
    expect(result[0]!.isWellFormed).toBe(true);
    expect(result[0]!.malformedLineCount).toBe(0);
  });

  it('lists multiple reviewers for the same task', () => {
    makeTranscriptDir(tmpRoot, 'aisdlc-383.1', 'code-reviewer');
    makeTranscriptDir(tmpRoot, 'aisdlc-383.1', 'test-reviewer');
    makeTranscriptDir(tmpRoot, 'aisdlc-383.1', 'security-reviewer');

    const result = listTranscripts(tmpRoot);
    expect(result).toHaveLength(3);
    const reviewers = result.map((r) => r.reviewerName).sort();
    expect(reviewers).toEqual(['code-reviewer', 'security-reviewer', 'test-reviewer']);
  });

  it('lists transcripts across multiple tasks', () => {
    makeTranscriptDir(tmpRoot, 'aisdlc-383.1', 'code-reviewer');
    makeTranscriptDir(tmpRoot, 'aisdlc-384', 'test-reviewer');

    const result = listTranscripts(tmpRoot);
    expect(result).toHaveLength(2);
    const taskIds = result.map((r) => r.taskId);
    expect(taskIds).toContain('aisdlc-383.1');
    expect(taskIds).toContain('aisdlc-384');
  });

  it('filters by taskId when filterTaskId is provided', () => {
    makeTranscriptDir(tmpRoot, 'aisdlc-383.1', 'code-reviewer');
    makeTranscriptDir(tmpRoot, 'aisdlc-383.1', 'test-reviewer');
    makeTranscriptDir(tmpRoot, 'aisdlc-384', 'code-reviewer');

    const result = listTranscripts(tmpRoot, 'aisdlc-383.1');
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.taskId === 'aisdlc-383.1')).toBe(true);
  });

  it('filterTaskId is case-insensitive', () => {
    makeTranscriptDir(tmpRoot, 'aisdlc-383.1', 'code-reviewer');

    const result = listTranscripts(tmpRoot, 'AISDLC-383.1');
    expect(result).toHaveLength(1);
  });

  it('returns empty array when filterTaskId matches no task', () => {
    makeTranscriptDir(tmpRoot, 'aisdlc-383.1', 'code-reviewer');

    const result = listTranscripts(tmpRoot, 'aisdlc-999');
    expect(result).toEqual([]);
  });

  it('marks transcript with malformed lines as not well-formed', () => {
    const dir = join(tmpRoot, '.ai-sdlc', 'transcripts', 'aisdlc-383.1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'code-reviewer.jsonl'),
      toJsonlLine(FIXTURE_PROMPT_EVENT) + 'bad json\n',
    );

    const result = listTranscripts(tmpRoot);
    expect(result[0]!.isWellFormed).toBe(false);
    expect(result[0]!.malformedLineCount).toBe(1);
  });

  it('sorts results by taskId then reviewerName', () => {
    makeTranscriptDir(tmpRoot, 'bbb', 'code-reviewer');
    makeTranscriptDir(tmpRoot, 'aaa', 'test-reviewer');
    makeTranscriptDir(tmpRoot, 'aaa', 'code-reviewer');

    const result = listTranscripts(tmpRoot);
    expect(result[0]!.taskId).toBe('aaa');
    expect(result[0]!.reviewerName).toBe('code-reviewer');
    expect(result[1]!.taskId).toBe('aaa');
    expect(result[1]!.reviewerName).toBe('test-reviewer');
    expect(result[2]!.taskId).toBe('bbb');
  });

  it('includes the prompt event in the event count', () => {
    makeTranscriptDir(tmpRoot, 'aisdlc-383.1', 'code-reviewer');

    const result = listTranscripts(tmpRoot);
    // fixture writes 2 events: FIXTURE_PROMPT_EVENT + FIXTURE_RESPONSE_EVENT
    expect(result[0]!.eventCount).toBeGreaterThanOrEqual(1);
    // At least one assistant response is present
    const dir = join(tmpRoot, '.ai-sdlc', 'transcripts', 'aisdlc-383.1', 'code-reviewer.jsonl');
    const { events } = parseTranscriptFile(dir);
    const hasAssistantTurn = events.some((e) => e.role === 'assistant');
    expect(hasAssistantTurn).toBe(true);
  });
});

// ── formatTranscriptTable ─────────────────────────────────────────────────────

describe('formatTranscriptTable', () => {
  it('returns a placeholder message when the input is empty', () => {
    const output = formatTranscriptTable([]);
    expect(output).toBe('(no transcripts found)');
  });

  it('includes header row', () => {
    const infos = [
      {
        taskId: 'aisdlc-383.1',
        reviewerName: 'code-reviewer',
        filePath: '/fake/path/code-reviewer.jsonl',
        eventCount: 3,
        byteSize: 512,
        isWellFormed: true,
        malformedLineCount: 0,
      },
    ];
    const output = formatTranscriptTable(infos);
    expect(output).toContain('TASK-ID');
    expect(output).toContain('REVIEWER');
    expect(output).toContain('EVENTS');
    expect(output).toContain('BYTES');
    expect(output).toContain('WELL-FORMED');
  });

  it('includes data rows with task-id and reviewer', () => {
    const infos = [
      {
        taskId: 'aisdlc-383.1',
        reviewerName: 'code-reviewer',
        filePath: '/fake/path/code-reviewer.jsonl',
        eventCount: 3,
        byteSize: 512,
        isWellFormed: true,
        malformedLineCount: 0,
      },
    ];
    const output = formatTranscriptTable(infos);
    expect(output).toContain('aisdlc-383.1');
    expect(output).toContain('code-reviewer');
    expect(output).toContain('3');
    expect(output).toContain('512');
    expect(output).toContain('yes');
  });

  it('shows malformed count for not-well-formed transcripts', () => {
    const infos = [
      {
        taskId: 'aisdlc-383.1',
        reviewerName: 'security-reviewer',
        filePath: '/fake/path/security-reviewer.jsonl',
        eventCount: 1,
        byteSize: 128,
        isWellFormed: false,
        malformedLineCount: 2,
      },
    ];
    const output = formatTranscriptTable(infos);
    expect(output).toContain('no (2 malformed)');
  });

  it('renders multiple rows', () => {
    const infos = [
      {
        taskId: 'aisdlc-383.1',
        reviewerName: 'code-reviewer',
        filePath: '/a',
        eventCount: 2,
        byteSize: 200,
        isWellFormed: true,
        malformedLineCount: 0,
      },
      {
        taskId: 'aisdlc-383.1',
        reviewerName: 'test-reviewer',
        filePath: '/b',
        eventCount: 3,
        byteSize: 300,
        isWellFormed: true,
        malformedLineCount: 0,
      },
    ];
    const output = formatTranscriptTable(infos);
    const lines = output.split('\n');
    // header + separator + 2 data rows = 4 lines
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });
});
