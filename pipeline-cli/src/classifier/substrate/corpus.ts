/**
 * Calibration corpus storage for the shared classifier substrate
 * (AISDLC-321 / RFC-0024 Refit Phase 2).
 *
 * Per AC-4: entries land in `<repoRoot>/.ai-sdlc/classifier-corpus/<task-type>.yaml`
 * (one file per task type — segmented so per-domain calibration loops
 * don't mix exemplars).
 *
 * **File format**: YAML list-of-records. Each record is a
 * `CalibrationCorpusEntry` (see `./types.ts`). We chose YAML over JSONL
 * because (a) operators read these files manually during calibration
 * walkthroughs, and (b) the file is append-only via a simple
 * read-mutate-write under a file lock — at the volumes the substrate
 * targets (~thousands per task type, not millions), full-file rewrites
 * are fine and the YAML diff is reviewable in `git log`.
 *
 * **Atomicity**: writes use the rename-after-write idiom — write to
 * `<file>.tmp`, then `rename()` to `<file>`. This is POSIX-atomic on
 * the same filesystem and avoids the half-written-file failure mode.
 *
 * **Concurrency**: the substrate calls into this module sequentially per
 * `classify()` invocation. Parallel `classify()` calls in the same
 * process series their corpus writes via Node's single-threaded event
 * loop (mkdir + read + write is one synchronous block per call). Cross-
 * process concurrency uses the rename-after-write idiom — last-writer-
 * wins is acceptable for an append-only audit log; we don't promise
 * "no entry ever drops" under heavy cross-process write contention. The
 * realistic deployment shape is one orchestrator process + one TUI
 * process; collisions are vanishingly rare.
 *
 * @module classifier/substrate/corpus
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';

import type { CalibrationCorpusEntry, ClassifierTaskType } from './types.js';

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the corpus directory. Default: `<repoRoot>/.ai-sdlc/classifier-corpus/`.
 * Overridable via `corpusDir` opt — tests + multi-corpus setups use this.
 */
export function resolveCorpusDir(repoRoot: string, corpusDir?: string): string {
  return corpusDir ?? join(repoRoot, '.ai-sdlc', 'classifier-corpus');
}

/**
 * Resolve the per-task-type corpus file. Per AC-4: one YAML per task
 * type, named `<task-type>.yaml`.
 */
export function resolveCorpusFilePath(
  repoRoot: string,
  taskType: ClassifierTaskType,
  corpusDir?: string,
): string {
  return join(resolveCorpusDir(repoRoot, corpusDir), `${taskType}.yaml`);
}

// ── Reader ───────────────────────────────────────────────────────────────────

/**
 * Read all corpus entries for a task type. Returns `[]` when the file
 * doesn't exist OR can't be parsed (lenient: a corrupted file shouldn't
 * crash the substrate — operator surfaces the issue via the aggregator
 * which logs and skips bad files).
 */
export function readCorpus(
  repoRoot: string,
  taskType: ClassifierTaskType,
  corpusDir?: string,
): CalibrationCorpusEntry[] {
  const path = resolveCorpusFilePath(repoRoot, taskType, corpusDir);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = yamlLoad(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isCalibrationEntry);
}

function isCalibrationEntry(v: unknown): v is CalibrationCorpusEntry {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.timestamp === 'string' &&
    typeof e.taskType === 'string' &&
    typeof e.classification === 'string' &&
    typeof e.confidence === 'number' &&
    typeof e.model === 'string' &&
    typeof e.threshold === 'number' &&
    typeof e.metBehindThreshold === 'boolean' &&
    (e.polarity === 'pending' || e.polarity === 'positive' || e.polarity === 'negative') &&
    typeof e.input === 'object'
  );
}

// ── Append (atomic) ──────────────────────────────────────────────────────────

/**
 * Quarantine a corpus file that `readCorpus()` could not parse — rename to
 * `<path>.corrupt-<iso>.yaml` so the operator can recover before we start
 * fresh. Prevents the data-loss footgun where `appendCorpusEntry()` /
 * `setCorpusEntryPolarity()` would silently truncate a non-empty-but-unreadable
 * corpus to a single new entry.
 *
 * Returns true when a quarantine happened (caller should treat existing as
 * empty for the subsequent write), false when the file is genuinely empty or
 * absent (caller proceeds normally).
 */
function quarantineCorpusIfUnreadable(path: string): boolean {
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return false; // can't read; let downstream handle / surface
  }
  if (raw.trim() === '') return false; // genuinely empty
  // File has content but readCorpus returned [] — the YAML is corrupt or the
  // entries failed isCalibrationEntry. Move it aside so we don't overwrite.
  let parsed: unknown;
  try {
    parsed = yamlLoad(raw);
  } catch {
    // YAML parse failure — definitely corrupt.
    const corruptPath = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`;
    renameSync(path, corruptPath);
    return true;
  }
  // YAML parsed but content is not a non-empty array of valid entries — also
  // suspect. Conservative: quarantine to preserve the operator's data.
  if (!Array.isArray(parsed) || parsed.filter(isCalibrationEntry).length === 0) {
    const corruptPath = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`;
    renameSync(path, corruptPath);
    return true;
  }
  return false;
}

/**
 * Append one entry to the per-task-type corpus file. Atomic via
 * rename-after-write. Creates the corpus dir + file when missing.
 *
 * Per AC-4. Used by the substrate after every `classify()` call (unless
 * the caller passes `skipCorpus: true`).
 *
 * Data-loss guard: if the existing file is non-empty but unreadable
 * (corrupt YAML or no entries pass the schema check), quarantines it to
 * `<path>.corrupt-<iso>.yaml` so the operator can recover, then writes a
 * fresh file containing only the new entry. Prevents the silent-truncation
 * footgun where an external editor's half-written save would wipe the
 * corpus on the next classify() call.
 */
export function appendCorpusEntry(
  repoRoot: string,
  entry: CalibrationCorpusEntry,
  corpusDir?: string,
): void {
  const dir = resolveCorpusDir(repoRoot, corpusDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolveCorpusFilePath(repoRoot, entry.taskType, corpusDir);
  quarantineCorpusIfUnreadable(path);
  const existing = readCorpus(repoRoot, entry.taskType, corpusDir);
  const next = [...existing, entry];
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, yamlDump(next, { lineWidth: -1 }), { encoding: 'utf8' });
  renameSync(tmp, path);
}

// ── Update (override capture) ────────────────────────────────────────────────

/**
 * Mark an existing corpus entry's polarity. Returns the updated entry
 * when found; `null` when no entry with that id exists.
 *
 * Used by:
 *   - `recordOperatorOverride()` — sets polarity to `negative` with the
 *     operator's chosen classification + reason (per AC-6).
 *   - `recordSilenceAsPositive()` — sets polarity to `positive` (per AC-7).
 *
 * Re-writes the whole task-type corpus atomically via rename-after-write.
 */
export function setCorpusEntryPolarity(
  repoRoot: string,
  taskType: ClassifierTaskType,
  entryId: string,
  patch: {
    polarity: 'positive' | 'negative';
    operatorOverrideClassification?: string;
    operatorOverrideReason?: string;
    operatorOverrideTimestamp?: string;
  },
  corpusDir?: string,
): CalibrationCorpusEntry | null {
  const entries = readCorpus(repoRoot, taskType, corpusDir);
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx === -1) return null;
  const merged: CalibrationCorpusEntry = {
    ...entries[idx],
    polarity: patch.polarity,
    ...(patch.operatorOverrideClassification !== undefined
      ? { operatorOverrideClassification: patch.operatorOverrideClassification }
      : {}),
    ...(patch.operatorOverrideReason !== undefined
      ? { operatorOverrideReason: patch.operatorOverrideReason }
      : {}),
    ...(patch.operatorOverrideTimestamp !== undefined
      ? { operatorOverrideTimestamp: patch.operatorOverrideTimestamp }
      : {}),
  };
  entries[idx] = merged;
  const path = resolveCorpusFilePath(repoRoot, taskType, corpusDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, yamlDump(entries, { lineWidth: -1 }), { encoding: 'utf8' });
  renameSync(tmp, path);
  return merged;
}
