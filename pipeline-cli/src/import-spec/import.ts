/**
 * Top-level orchestrator for `cli-import-spec`.
 *
 * RFC-0036 Phase 4 (AISDLC-329) shipped the read-parse-write loop. Phase 5
 * (AISDLC-330) wires the DoR Gate into the path:
 *
 *   - Default `--rubric strict`: every generated task runs DoR. Failures
 *     refuse import (no placeholder) and emit a clarification task back
 *     upstream per OQ-10.
 *   - `--rubric warn`: failures admit the task with warnings surfaced.
 *   - Analyze metadata at `.specify/analyze.json` auto-resolves matching
 *     gates via the Decision Catalog per OQ-7 — only NEW gaps reach the
 *     operator.
 *
 * Per OQ-1 the bridge is `tasks.md` only — no fallback. Per OQ-11 the
 * parser auto-detects the schema and refuses unknown versions.
 *
 * @module import-spec/import
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { loadAdopterAuthoringConfig, type DorStrictness } from './config.js';
import { parseTasksMd } from './parser.js';
import {
  emitIncompleteSpecDecision,
  emitUnknownSchemaDecision,
  type DecisionEmitOutcome,
} from './decisions.js';
import {
  renderTaskMarkdown,
  writeBacklogTaskFromSpecKitEntry,
  type SpecRef,
  type WrittenTask,
} from './task-writer.js';
import {
  runDorAtImport,
  type AnalyzeMetadata,
  type DorAtImportPerTaskResult,
  type RunDorAtImportOpts,
} from './dor-at-import.js';
import type { RefineBacklogTaskResult } from '../dor/ingress-claude.js';

export type ImportOutcome =
  | {
      kind: 'imported';
      writtenTasks: WrittenTask[];
      /**
       * DoR outcome per upstream task, in the same order as `writtenTasks`
       * for `admitted` / `admitted-with-warnings` entries. Refused entries
       * appear in `refusedTasks` instead and are absent from `writtenTasks`.
       */
      perTaskDor: DorAtImportPerTaskResult[];
      /**
       * Upstream entries whose imports were refused under `--rubric strict`
       * (OQ-3 + OQ-10). Present + non-empty when at least one task failed
       * DoR and the operator should triage the emitted clarification tasks.
       */
      refusedTasks: DorAtImportPerTaskResult[];
      tasksMdPath: string;
      featureId: string;
      strictness: DorStrictness;
    }
  | { kind: 'incomplete-spec'; decision: DecisionEmitOutcome; reason: string }
  | {
      kind: 'unknown-schema';
      decision: DecisionEmitOutcome;
      tasksMdPath: string;
    };

export interface ImportSpecOpts {
  /** Path the operator passed to `--from`. Either a spec-kit feature directory or a tasks.md. */
  from: string;
  /** Project root for backlog writes + decision events. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Override the importedAt stamp (tests). */
  importedAt?: string;
  /**
   * DoR strictness override (OQ-3). Defaults to the
   * `adopter-authoring.yaml` value (strict by default per RFC §14.1).
   * The CLI surfaces this via `--rubric strict|warn`.
   */
  strictness?: DorStrictness;
  /**
   * Analyze metadata path override (OQ-7). Relative to `workDir`.
   * Defaults to the adopter-authoring config value
   * (`.specify/analyze.json`).
   */
  analyzeMetadataPath?: string;
  /**
   * Inject the analyze-metadata reader entirely (tests). Bypasses
   * `analyzeMetadataPath` resolution.
   */
  readAnalyzeMetadata?: () => AnalyzeMetadata | null;
  /**
   * Override the DoR evaluator (tests). The orchestrator calls this for
   * every generated task. Production defers to {@link refineBacklogTask}.
   */
  evaluateDor?: (taskFilePath: string) => Promise<RefineBacklogTaskResult>;
}

export interface ImportSpecResult {
  outcome: ImportOutcome;
  /** Effective work directory used (resolved absolute path). */
  workDir: string;
}

/**
 * Resolve the `--from` argument to an absolute spec-kit `tasks.md` path.
 * Accepts either the feature directory (`<spec-root>/<feature>/`) or the
 * file directly. Returns null when no `tasks.md` exists at the expected
 * location.
 */
export function resolveTasksMdPath(fromPath: string): string | null {
  const abs = isAbsolute(fromPath) ? fromPath : resolve(fromPath);
  if (!existsSync(abs)) return null;
  const st = statSync(abs);
  if (st.isFile()) {
    return basename(abs).toLowerCase() === 'tasks.md' ? abs : null;
  }
  if (st.isDirectory()) {
    const candidate = join(abs, 'tasks.md');
    return existsSync(candidate) ? candidate : null;
  }
  return null;
}

/**
 * Derive the spec-kit feature identifier from the resolved `tasks.md` path.
 * Convention: the feature dir is the parent of `tasks.md`.
 */
export function deriveFeatureId(tasksMdPath: string): string {
  const parts = tasksMdPath.split(/[\\/]/);
  // last segment is `tasks.md`, parent is the feature dir
  return parts.length >= 2 ? parts[parts.length - 2] : 'unknown-feature';
}

/**
 * Run the import. Pure orchestrator — delegates parsing, writing, DoR
 * evaluation, and Decision emission to the helpers in this module so
 * each piece is independently testable.
 */
export async function importSpec(opts: ImportSpecOpts): Promise<ImportSpecResult> {
  const workDir = opts.workDir ?? process.cwd();
  const config = loadAdopterAuthoringConfig({ workDir });

  const tasksMdPath = resolveTasksMdPath(opts.from);
  if (tasksMdPath === null) {
    const decision = emitIncompleteSpecDecision({
      workDir,
      fromPath: opts.from,
      reason: 'tasks.md missing or unreadable at the supplied path',
    });
    return {
      workDir,
      outcome: {
        kind: 'incomplete-spec',
        decision,
        reason: 'tasks.md missing or unreadable',
      },
    };
  }

  const source = readFileSync(tasksMdPath, 'utf8');
  const parsed = parseTasksMd(source);
  if (parsed.schemaVersion === 'unknown') {
    const decision = emitUnknownSchemaDecision({
      workDir,
      fromPath: opts.from,
      tasksMdPath,
    });
    return {
      workDir,
      outcome: { kind: 'unknown-schema', decision, tasksMdPath },
    };
  }

  const featureId = deriveFeatureId(tasksMdPath);
  const strictness: DorStrictness = opts.strictness ?? config.import.dorStrictness;
  const artifactPath = relativeIfPossible(tasksMdPath, workDir);
  const importedAt = opts.importedAt ?? new Date().toISOString();

  const writtenTasks: WrittenTask[] = [];
  const perTaskDor: DorAtImportPerTaskResult[] = [];
  const refusedTasks: DorAtImportPerTaskResult[] = [];

  for (const entry of parsed.entries) {
    const dorOpts: RunDorAtImportOpts = {
      workDir,
      strictness,
      featureId,
      artifactPath,
      importedAt,
    };
    if (opts.analyzeMetadataPath !== undefined) {
      dorOpts.analyzeMetadataPath = opts.analyzeMetadataPath;
    }
    if (opts.readAnalyzeMetadata !== undefined) {
      dorOpts.readAnalyzeMetadata = opts.readAnalyzeMetadata;
    }
    if (opts.evaluateDor !== undefined) {
      dorOpts.evaluateDor = opts.evaluateDor;
    }

    // Render the same markdown the writer would produce so DoR scores
    // exactly the body the operator would see (not an approximation).
    const renderMarkdown = (allocatedId: string): string => {
      const specRef: SpecRef = {
        source: 'spec-kit',
        featureId,
        taskId: entry.taskId,
        artifactPath,
        importedAt,
      };
      return renderTaskMarkdown(allocatedId, entry, specRef);
    };

    const perTask = await runDorAtImport({ entry, renderTaskMarkdown: renderMarkdown }, dorOpts);
    perTaskDor.push(perTask);

    if (perTask.outcome.kind === 'refused-strict') {
      refusedTasks.push(perTask);
      // OQ-10: no placeholder is created. Move on to the next entry.
      continue;
    }

    // `admitted` or `admitted-with-warnings` → write the real backlog task.
    writtenTasks.push(
      writeBacklogTaskFromSpecKitEntry(entry, {
        workDir,
        featureId,
        artifactPath,
        importedAt,
      }),
    );
  }

  return {
    workDir,
    outcome: {
      kind: 'imported',
      writtenTasks,
      perTaskDor,
      refusedTasks,
      tasksMdPath,
      featureId,
      strictness,
    },
  };
}

function relativeIfPossible(target: string, workDir: string): string {
  const absWork = resolve(workDir);
  const absTarget = resolve(target);
  if (absTarget.startsWith(absWork)) {
    return absTarget.slice(absWork.length).replace(/^[\\/]/, '');
  }
  return target;
}
