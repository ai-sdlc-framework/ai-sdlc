/**
 * Top-level orchestrator for `cli-import-spec`.
 *
 * RFC-0036 Phase 4 (AISDLC-329). Reads the parsed config, locates the
 * spec-kit `tasks.md`, parses entries, writes backlog tasks with
 * `specRef:` back-references. Failure modes (missing tasks.md, unknown
 * schema) route through the Decision Catalog (Phase 4 stops here; DoR at
 * import is Phase 5 (AISDLC-330); reconcile is Phase 6 (AISDLC-331)).
 *
 * Per OQ-1 the bridge is `tasks.md` only — no fallback. Per OQ-11 the
 * parser auto-detects the schema and refuses unknown versions.
 *
 * @module import-spec/import
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { loadAdopterAuthoringConfig } from './config.js';
import { parseTasksMd } from './parser.js';
import {
  emitIncompleteSpecDecision,
  emitUnknownSchemaDecision,
  type DecisionEmitOutcome,
} from './decisions.js';
import { writeBacklogTaskFromSpecKitEntry, type WrittenTask } from './task-writer.js';

export type ImportOutcome =
  | { kind: 'imported'; writtenTasks: WrittenTask[]; tasksMdPath: string; featureId: string }
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
 * Run the import. Pure orchestrator — delegates parsing, writing, and
 * Decision emission to the helpers in this module so each piece is
 * independently testable.
 */
export function importSpec(opts: ImportSpecOpts): ImportSpecResult {
  const workDir = opts.workDir ?? process.cwd();
  // Load the config — Phase 4 reads only `import.*` keys; Phase 5+ consume
  // additional slices. We invoke this for the side-effect of validating the
  // YAML parses + applying defaults (and so the operator sees a clear error
  // on malformed config).
  loadAdopterAuthoringConfig({ workDir });

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
  const writtenTasks: WrittenTask[] = [];
  for (const entry of parsed.entries) {
    writtenTasks.push(
      writeBacklogTaskFromSpecKitEntry(entry, {
        workDir,
        featureId,
        artifactPath: relativeIfPossible(tasksMdPath, workDir),
        importedAt: opts.importedAt,
      }),
    );
  }

  return {
    workDir,
    outcome: {
      kind: 'imported',
      writtenTasks,
      tasksMdPath,
      featureId,
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
