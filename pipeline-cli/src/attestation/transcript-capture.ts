/**
 * transcript-capture.ts — RFC-0042 Phase 1 transcript capture helpers.
 *
 * Provides utilities for reading and validating JSONL transcript files
 * emitted by reviewer subagents to `.ai-sdlc/transcripts/<task-id>/<reviewer>.jsonl`.
 *
 * Per RFC-0042 §Design Layer 1:
 *   - Files are gitignored (local disk, 90-day retention by default per OQ-1)
 *   - Each line is a structured event: { role, content, timestamp, event? }
 *   - `cli-attestation transcripts list` surfaces these files to operators
 *
 * @module attestation/transcript-capture
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────────

/** A single JSONL event emitted by a reviewer subagent. */
export interface TranscriptEvent {
  /** The speaker: 'user' (prompt) or 'assistant' (response). */
  role: 'user' | 'assistant' | 'tool' | 'tool_result';
  /** The text content of the turn or tool result. */
  content: string;
  /** ISO-8601 timestamp of when the event was emitted. */
  timestamp: string;
  /** Optional event type discriminator (e.g. 'prompt-received', 'verdict-formed'). */
  event?: string;
  /** Optional: for tool events, the tool name. */
  toolName?: string;
  /** Optional: harness that produced this event (e.g. 'codex' for cross-harness). */
  harness?: string;
}

/** Metadata about a single reviewer's transcript file. */
export interface TranscriptFileInfo {
  /** The task ID (directory name under .ai-sdlc/transcripts/). */
  taskId: string;
  /** The reviewer name (file stem under the task directory). */
  reviewerName: string;
  /** Absolute path to the JSONL file. */
  filePath: string;
  /** Number of events (lines) in the file. */
  eventCount: number;
  /** File size in bytes. */
  byteSize: number;
  /** Whether every line parsed as valid JSON with required fields. */
  isWellFormed: boolean;
  /** Number of lines that failed validation (0 for well-formed transcripts). */
  malformedLineCount: number;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate that a parsed object is a valid TranscriptEvent.
 * Returns true if the object has the required `role`, `content`, and `timestamp` fields
 * with appropriate types.
 */
export function isValidTranscriptEvent(obj: unknown): obj is TranscriptEvent {
  if (typeof obj !== 'object' || obj === null) return false;
  const event = obj as Record<string, unknown>;
  if (typeof event['role'] !== 'string') return false;
  if (!['user', 'assistant', 'tool', 'tool_result'].includes(event['role'] as string)) return false;
  if (typeof event['content'] !== 'string') return false;
  if (typeof event['timestamp'] !== 'string') return false;
  // Validate ISO-8601 timestamp by checking it parses to a valid date
  const parsed = new Date(event['timestamp'] as string);
  if (isNaN(parsed.getTime())) return false;
  return true;
}

/**
 * Parse a JSONL transcript file into an array of TranscriptEvent objects.
 *
 * Lines that are blank or contain only whitespace are skipped.
 * Lines that fail JSON.parse or fail validation are counted as malformed
 * and included in the returned `malformedLines` count.
 */
export function parseTranscriptFile(filePath: string): {
  events: TranscriptEvent[];
  malformedLines: number;
} {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const events: TranscriptEvent[] = [];
  let malformedLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // blank line

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValidTranscriptEvent(parsed)) {
        events.push(parsed);
      } else {
        malformedLines++;
      }
    } catch {
      malformedLines++;
    }
  }

  return { events, malformedLines };
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Resolve the base transcripts directory for a given repo root.
 * Returns `<repoRoot>/.ai-sdlc/transcripts`.
 */
export function resolveTranscriptsDir(repoRoot: string): string {
  return join(repoRoot, '.ai-sdlc', 'transcripts');
}

/**
 * List all transcript files under `.ai-sdlc/transcripts/`, optionally
 * filtered to a single task ID.
 *
 * Returns an array of TranscriptFileInfo sorted by taskId then reviewerName.
 * Returns an empty array if the transcripts directory does not exist.
 */
export function listTranscripts(repoRoot: string, filterTaskId?: string): TranscriptFileInfo[] {
  const transcriptsDir = resolveTranscriptsDir(repoRoot);

  if (!existsSync(transcriptsDir)) {
    return [];
  }

  const results: TranscriptFileInfo[] = [];

  // Enumerate task directories
  const taskDirs = readdirSync(transcriptsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !filterTaskId || name.toLowerCase() === filterTaskId.toLowerCase());

  for (const taskId of taskDirs) {
    const taskDir = join(transcriptsDir, taskId);
    const files = readdirSync(taskDir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
      .map((f) => f.name);

    for (const fileName of files) {
      const reviewerName = fileName.replace(/\.jsonl$/, '');
      const filePath = join(taskDir, fileName);
      const stat = statSync(filePath);
      const byteSize = stat.size;

      const { events, malformedLines } = parseTranscriptFile(filePath);

      results.push({
        taskId,
        reviewerName,
        filePath,
        eventCount: events.length,
        byteSize,
        isWellFormed: malformedLines === 0,
        malformedLineCount: malformedLines,
      });
    }
  }

  // Sort by taskId ascending, then reviewerName ascending
  results.sort((a, b) => {
    const taskCmp = a.taskId.localeCompare(b.taskId);
    if (taskCmp !== 0) return taskCmp;
    return a.reviewerName.localeCompare(b.reviewerName);
  });

  return results;
}

/**
 * Format a TranscriptFileInfo array as a human-readable table for CLI display.
 *
 * Columns: task-id, reviewer, events, bytes, well-formed
 */
export function formatTranscriptTable(infos: TranscriptFileInfo[]): string {
  if (infos.length === 0) {
    return '(no transcripts found)';
  }

  const header = [
    'TASK-ID'.padEnd(24),
    'REVIEWER'.padEnd(26),
    'EVENTS'.padStart(7),
    'BYTES'.padStart(8),
    'WELL-FORMED',
  ].join('  ');

  const separator = '-'.repeat(header.length);

  const rows = infos.map((info) =>
    [
      info.taskId.padEnd(24),
      info.reviewerName.padEnd(26),
      String(info.eventCount).padStart(7),
      String(info.byteSize).padStart(8),
      info.isWellFormed ? 'yes' : `no (${info.malformedLineCount} malformed)`,
    ].join('  '),
  );

  return [header, separator, ...rows].join('\n');
}
