/**
 * Telemetry ingestion — reads tool sequence JSONL and session-meta
 * JSON files into ToolSequenceEvent format for pattern detection.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolSequenceEvent } from '../state/types.js';
import type { RawToolSequenceEntry, SessionMeta, CanonicalStep } from './types.js';

/**
 * Read tool sequence entries from a JSONL file.
 * Each line is a JSON object with ts, sid, tool, action, project.
 */
export function readToolSequenceJSONL(filePath: string): ToolSequenceEvent[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf-8');
  const events: ToolSequenceEvent[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const raw: RawToolSequenceEntry = JSON.parse(trimmed);
      events.push({
        sessionId: raw.sid,
        toolName: raw.tool,
        actionCanonical: raw.action,
        projectPath: raw.project,
        timestamp: raw.ts,
      });
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

/**
 * Read session metadata from the Claude Code usage-data directory.
 * Returns metadata for all sessions found.
 */
export function readSessionMetaFiles(usageDataDir: string): SessionMeta[] {
  const metaDir = join(usageDataDir, 'session-meta');
  if (!existsSync(metaDir)) return [];

  const files = readdirSync(metaDir).filter((f) => f.endsWith('.json'));
  const sessions: SessionMeta[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(metaDir, file), 'utf-8');
      const meta = JSON.parse(content) as SessionMeta;
      if (meta.session_id && meta.tool_counts) {
        sessions.push(meta);
      }
    } catch {
      // Skip malformed files
    }
  }

  return sessions;
}

/**
 * Convert session-meta tool_counts into synthetic ToolSequenceEvents.
 * Since session-meta only has aggregate counts (no ordering), these
 * events are useful for frequency analysis but not sequence mining.
 */
export function sessionMetaToEvents(meta: SessionMeta): ToolSequenceEvent[] {
  const events: ToolSequenceEvent[] = [];
  const timestamp = meta.start_time;

  for (const [tool, count] of Object.entries(meta.tool_counts)) {
    for (let i = 0; i < count; i++) {
      events.push({
        sessionId: meta.session_id,
        toolName: tool,
        actionCanonical: tool.toLowerCase(),
        projectPath: meta.project_path,
        timestamp,
      });
    }
  }

  return events;
}

/**
 * Categorize a tool action into a workflow category.
 */
export function categorizeAction(tool: string, action: string): CanonicalStep['category'] {
  const lower = action.toLowerCase();

  if (tool === 'Read' || lower.startsWith('read:')) return 'read';
  if (
    tool === 'Edit' ||
    tool === 'Write' ||
    lower.startsWith('edit:') ||
    lower.startsWith('write:')
  )
    return 'write';
  if (lower.includes('test') || lower.includes('vitest') || lower.includes('jest')) return 'test';
  if (lower.includes('build') || lower.includes('tsc') || lower.includes('compile')) return 'build';
  if (lower.startsWith('git ') || lower.startsWith('gh ')) return 'git';
  if (tool === 'Grep' || tool === 'Glob' || lower.startsWith('grep:') || lower.startsWith('glob:'))
    return 'search';

  return 'other';
}
