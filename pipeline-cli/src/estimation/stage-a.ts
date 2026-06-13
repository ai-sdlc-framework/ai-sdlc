/**
 * Stage A entry point — RFC-0016 §5.
 *
 * Top-level façade: takes a task ID + workDir, gathers the deterministic
 * signal inputs from disk, runs every Phase 1 signal collector, and
 * aggregates into a single Stage A verdict. All disk reads live in this
 * module so the collectors in `signals.ts` and the aggregator in
 * `aggregator.ts` remain pure (and trivially unit-testable).
 *
 * Phase 1 surface — no LLM calls, no Stage B invocation, no calibration
 * log writes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTaskFile, parseSimpleYaml, parseTaskFile } from '../steps/01-validate.js';
import { buildDependencyGraph, blockers } from '../deps/dependency-graph.js';
import { aggregate } from './aggregator.js';
import { assignClass } from './class-assignment.js';
import { assignClassCached } from './cache.js';
import {
  blockedPathsSignal,
  classDefaultSignal,
  coverageSignal,
  dependencyDepthSignal,
  fileScopeSignal,
  fileTypeSignal,
  historicalActualsSignal,
  locDeltaSignal,
  reviewerIterationSignal,
} from './signals.js';
import type { SignalOutput, StageAResult } from './types.js';

export interface StageAOptions {
  taskId: string;
  workDir: string;
  /**
   * Optional planning LOC estimate. Phase 1 has no upstream that produces
   * this number; the operator can override on the CLI with `--loc N` to
   * preview the Phase 2 / 3 behaviour. When undefined, signal #3 returns
   * `unknown`.
   */
  loc?: number;
  /**
   * Optional artifacts directory for the Phase 2 class-assignment cache.
   * When omitted, `assignClassCached` falls back to `$ARTIFACTS_DIR` /
   * `<cwd>/artifacts`. Tests inject a tmp dir; production leaves this
   * undefined.
   */
  artifactsDir?: string;
  /**
   * Skip the Phase 2 cache and use the pure `assignClass` heuristic
   * directly. Off by default; the cache is the production path. Tests
   * that probe the §5.3 worked-example shape — and the Phase 1 test
   * suite that ran before Phase 2 cached — pass `true` so a stale cache
   * row from a previous run can't shadow the fresh classification.
   */
  skipClassCache?: boolean;
}

/**
 * Run Stage A end-to-end for one task. Returns a complete `StageAResult`
 * with one row per §5.1 signal (including the Phase-3 stubs) so the CLI
 * output mirrors the RFC's signal-table layout 1:1.
 *
 * Throws if the task file is missing — the caller is responsible for
 * surfacing that to the operator (the CLI maps it to a non-zero exit).
 */
export function runStageA(opts: StageAOptions): StageAResult {
  const taskFilePath = findTaskFile(opts.taskId, opts.workDir);
  if (!taskFilePath) {
    throw new Error(`task file not found for ${opts.taskId} under ${opts.workDir}/backlog/tasks/`);
  }
  const task = parseTaskFile(taskFilePath);

  // Class assignment — read `class:` from frontmatter (raw, lower-cased)
  // or fall back to the title heuristic. The frontmatter value isn't
  // surfaced through `parseTaskFile` because it isn't part of the core
  // `TaskSpec` shape, so we re-parse just the YAML block here.
  //
  // Phase 2 — the heuristic stand-in for the §6.1 LLM classifier is
  // routed through the on-disk cache (`assignClassCached`) so the
  // assigner runs at most ONCE per repo per unique (title, description)
  // pair. Phase 4+ swaps the underlying assigner for the real LLM with
  // zero changes here.
  const frontmatterClass = readFrontmatterClass(taskFilePath);
  const cls = opts.skipClassCache
    ? assignClass({ frontmatterClass, title: task.title })
    : (() => {
        const cached = assignClassCached({
          taskId: task.id,
          title: task.title,
          description: task.description ?? '',
          ...(frontmatterClass !== undefined ? { frontmatterClass } : {}),
          ...(opts.artifactsDir !== undefined ? { artifactsDir: opts.artifactsDir } : {}),
        });
        // The Stage A result type's `classSource` is the narrower
        // assigner-side enum (`frontmatter | heuristic | default`).
        // `llm` is reserved for Phase 4+ when the assigner gets swapped;
        // it cannot appear in Phase 2 (the underlying assigner is still
        // the heuristic). Narrow defensively in case the cache is
        // pre-populated from a future-version assigner.
        const source: 'frontmatter' | 'heuristic' | 'default' =
          cached.source === 'llm' ? 'default' : cached.source;
        return { taskClass: cached.taskClass, source };
      })();

  const references = task.references ?? [];

  // Coverage requirement — read .codecov.yml once.
  const codecovPath = join(opts.workDir, 'codecov.yml');
  const codecovAlt = join(opts.workDir, '.codecov.yml');
  const codecovChosen = existsSync(codecovPath)
    ? codecovPath
    : existsSync(codecovAlt)
      ? codecovAlt
      : null;
  const patchThreshold = codecovChosen ? readCodecovPatchThreshold(codecovChosen) : undefined;

  // Dependency depth — run cli-deps blockers in-process via the
  // dependency-graph builder. Total blockers (transitive) is the depth
  // proxy per §5.1 row #5.
  let dependencyDepth: number;
  try {
    const graph = buildDependencyGraph({ workDir: opts.workDir });
    dependencyDepth = blockers(graph, opts.taskId).length;
  } catch {
    // Tolerate: a graph build failure shouldn't crash Stage A.
    dependencyDepth = 0;
  }

  const signals: SignalOutput[] = [
    fileScopeSignal({ fileCount: references.length }),
    historicalActualsSignal({ taskClass: cls.taskClass }),
    locDeltaSignal({ ...(opts.loc !== undefined ? { loc: opts.loc } : {}) }),
    coverageSignal({
      hasCodecovYaml: codecovChosen !== null,
      ...(patchThreshold !== undefined ? { patchThreshold } : {}),
    }),
    dependencyDepthSignal({ depth: dependencyDepth }),
    blockedPathsSignal({ references }),
    fileTypeSignal({ references }),
    reviewerIterationSignal({ taskClass: cls.taskClass }),
    classDefaultSignal({ taskClass: cls.taskClass }),
  ];

  const agg = aggregate(signals);

  return {
    taskId: task.id,
    taskClass: cls.taskClass,
    classSource: cls.source,
    signals,
    candidateBucket: agg.candidateBucket,
    ...(agg.candidateRange ? { candidateRange: agg.candidateRange } : {}),
    confidence: agg.confidence,
    escalateToStageB: agg.escalateToStageB,
    rationale: agg.rationale,
  };
}

/**
 * Read the `class:` field directly from the task's YAML frontmatter.
 * Returns `undefined` when the file is missing or the field is absent.
 * Kept private — exposed only via `runStageA`'s composite output.
 */
function readFrontmatterClass(taskFilePath: string): string | undefined {
  try {
    const raw = readFileSync(taskFilePath, 'utf8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return undefined;
    const fm = parseSimpleYaml(fmMatch[1]!);
    const val = fm.class;
    if (typeof val === 'string' && val.trim() !== '') return val.trim();
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the patch-coverage threshold percentage from a codecov YAML.
 * Returns the integer percent (e.g. 80) or `undefined` when the file
 * is missing the expected `coverage.status.patch.default.target` path.
 */
function readCodecovPatchThreshold(yamlPath: string): number | undefined {
  try {
    const raw = readFileSync(yamlPath, 'utf8');
    // We avoid pulling js-yaml into a hot path; the field we need has a
    // predictable shape (`target: 80%` on a single line under
    // `coverage.status.patch.default`). A line scan is enough.
    const lines = raw.split(/\r?\n/);
    let inPatch = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('patch:')) {
        inPatch = true;
        continue;
      }
      if (inPatch && /^target:/.test(trimmed)) {
        const m = trimmed.match(/target:\s*(\d+(?:\.\d+)?)\s*%?/);
        if (m) {
          const n = Number.parseFloat(m[1]!);
          if (Number.isFinite(n)) return n;
        }
      }
      // Reset when we leave the indented patch block — a sibling top-level key.
      if (inPatch && /^\S/.test(line) && !line.trim().startsWith('patch:')) {
        // top-level key after patch — exit.
        inPatch = false;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
