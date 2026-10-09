/**
 * Automatic context clearing for every hierarchy session (AISDLC-766).
 *
 * The plugin's Stop hook calls `cli-hierarchy auto-clear --transcript <path>` after
 * each turn. This module reads the session's current context size from the usage
 * fields of the transcript, compares it with the role's threshold, and when it is
 * over, refreshes the session's handoff file and schedules `clear --self` with the
 * role's resume command. An executor that holds an inflight task is never cleared;
 * the clear is deferred, and the next turn after its verdict is written clears it.
 *
 * Thresholds: planner 150k, dispatch 120k, executor 120k tokens, overridable in
 * `<board-dir>/config.json` under `contextThresholds` (keys are the role names).
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { now as clock } from '../clock.js';
import { holdsInflight } from './clear.js';
import type { HierarchyRole } from './types.js';

export const DEFAULT_CONTEXT_THRESHOLDS: Record<HierarchyRole, number> = {
  planner: 150_000,
  'operator-dispatch': 120_000,
  executor: 120_000,
};

/** After a clear is scheduled, further turns inside this window do not schedule another. */
export const AUTO_CLEAR_DEBOUNCE_MS = 120_000;
/** Largest tail of the transcript examined. */
const TAIL_BYTES = 512 * 1024;

/** Config file read for threshold overrides. */
export function configPath(boardDir: string): string {
  return path.join(boardDir, 'config.json');
}

/** Resolve the thresholds: defaults, overridden by valid positive integers in the config. */
export function resolveThresholds(boardDir: string): Record<HierarchyRole, number> {
  const out = { ...DEFAULT_CONTEXT_THRESHOLDS };
  try {
    const file = configPath(boardDir);
    if (!existsSync(file)) return out;
    const doc = JSON.parse(readFileSync(file, 'utf-8')) as { contextThresholds?: unknown };
    const t = doc.contextThresholds;
    if (t && typeof t === 'object') {
      for (const role of Object.keys(out) as HierarchyRole[]) {
        const v = (t as Record<string, unknown>)[role];
        if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[role] = v;
      }
    }
  } catch {
    // malformed config: defaults
  }
  return out;
}

/**
 * Current context size in tokens from the newest assistant entry that carries usage
 * (input + cache creation + cache read), or null when none is readable.
 */
export function readContextTokens(transcriptPath: string): number | null {
  try {
    const fd = openSync(transcriptPath, 'r');
    let text: string;
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line || !line.includes('"usage"')) continue;
      let entry: { message?: { usage?: Record<string, unknown> } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // first line of a tail slice may be cut
      }
      const u = entry.message?.usage;
      if (!u) continue;
      const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
      const total =
        n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
      if (total > 0) return total;
    }
  } catch {
    return null;
  }
  return null;
}

/** What {@link decideAutoClear} concluded. */
export type AutoClearDecision =
  | { action: 'none'; reason: string; tokens: number | null; threshold: number }
  | { action: 'defer'; reason: string; tokens: number; threshold: number; taskId: string }
  | { action: 'clear'; tokens: number; threshold: number };

/** Inputs of {@link decideAutoClear}. */
export interface AutoClearInputs {
  boardDir: string;
  role: HierarchyRole;
  name: string;
  transcriptPath: string;
  now?: () => Date;
}

function stampFile(boardDir: string, name: string): string {
  return path.join(boardDir, 'handoff', `.auto-clear-${name}`);
}

/** True when a clear was scheduled for this session within the debounce window. */
export function recentlyScheduled(boardDir: string, name: string, nowMs: number): boolean {
  try {
    const f = stampFile(boardDir, name);
    return existsSync(f) && nowMs - statSync(f).mtimeMs < AUTO_CLEAR_DEBOUNCE_MS;
  } catch {
    return false;
  }
}

/** Record that a clear was scheduled now. */
export function markScheduled(boardDir: string, name: string): void {
  const f = stampFile(boardDir, name);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, '', 'utf-8');
}

/** Decide whether the session should clear itself now. Pure apart from reads. */
export function decideAutoClear(inputs: AutoClearInputs): AutoClearDecision {
  const nowMs = (inputs.now ?? clock)().getTime();
  const threshold = resolveThresholds(inputs.boardDir)[inputs.role];
  const tokens = readContextTokens(inputs.transcriptPath);
  if (tokens === null) {
    return { action: 'none', reason: 'no usage in the transcript', tokens, threshold };
  }
  if (tokens <= threshold) {
    return { action: 'none', reason: 'under the threshold', tokens, threshold };
  }
  if (recentlyScheduled(inputs.boardDir, inputs.name, nowMs)) {
    return { action: 'none', reason: 'a clear is already scheduled', tokens, threshold };
  }
  if (inputs.role === 'executor') {
    const held = holdsInflight(inputs.boardDir, inputs.name);
    if (held) {
      return {
        action: 'defer',
        reason: `holds ${held}; cleared once its verdict is written`,
        tokens,
        threshold,
        taskId: held,
      };
    }
  }
  return { action: 'clear', tokens, threshold };
}
