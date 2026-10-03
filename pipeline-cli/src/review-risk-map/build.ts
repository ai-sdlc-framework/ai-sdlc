/**
 * `buildRiskMap`: stages 0 to 2 of the staged review, assembled into one validated,
 * risk-ranked map and written under the artifacts directory.
 *
 * Ranking: a hunk the judgment layer did not judge, and a hunk with no structural
 * facts, carries `riskScore` 1. Every other hunk carries its judged Score. Ties are
 * broken by the judged Score, then by diff order, so the order is deterministic.
 *
 * @module review-risk-map/build
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  redactSecrets,
  validateReviewRiskMap,
  type EvaluateJudgmentContext,
} from '@ai-sdlc/reference';
import { classifyPathRisk } from '../classifier/classifier.js';
import { SECURITY_CATEGORIES, type SecurityCategory } from '../review-plan/types.js';
import { runStage0 } from './stage0.js';
import {
  collectStructural,
  unavailableStructuralProvider,
  type StructuralHunkRef,
  type StructuralProvider,
} from './structural.js';
import { runStage2, type HunkJudgmentInput } from './stage2.js';
import type {
  ReviewRiskMap,
  RiskMapCriterion,
  RiskMapHunk,
  RiskMapSourceFile,
  RiskMapVerifications,
} from './types.js';

/** Directory, under the artifacts directory, that holds risk map files. */
export const RISK_MAP_DIR = '_review-risk-map';
export const DEFAULT_FLAG_THRESHOLD = 0.5;
const MAX_CRITERIA = 500;

export interface BuildRiskMapOpts {
  /** The task's acceptance criteria, in order. */
  acceptanceCriteria?: readonly string[];
  /** Results the developer already produced. */
  verifications?: RiskMapVerifications;
  /** Judgment layer context. Absent or disabled leaves every hunk unjudged. */
  judgment?: EvaluateJudgmentContext;
  /** Stage 1 facts. Defaults to a provider with none, so structural facts are unavailable. */
  structural?: StructuralProvider;
  /** Defaults to `$ARTIFACTS_DIR`, then `./_artifacts`. */
  artifactsDir?: string;
  /** Names the map file. Defaults to the task id, then `run`. */
  runId?: string;
  sourceKind?: string;
  taskId?: string;
  /** Noul probability at or above which a hunk is flagged for a security category. */
  flagThreshold?: number;
  maxHunksPerRequest?: number;
  now?: () => Date;
}

export interface BuildRiskMapResult {
  map: ReviewRiskMap;
  /** Absolute path of the JSON file the map was written to. */
  filePath: string;
}

const safeText = (s: string, max: number): string => redactSecrets(s).slice(0, max);

function flagsFor(
  hunk: { file: string; fileClass: string; secretMarkers: string[] },
  authAuthz: number | undefined,
  inputHandling: number | undefined,
  threshold: number,
): SecurityCategory[] {
  const out = new Set<SecurityCategory>();
  if ((authAuthz ?? 0) >= threshold || classifyPathRisk([hunk.file]).touchesAuth) {
    out.add('authentication');
    out.add('authorization');
  }
  if ((inputHandling ?? 0) >= threshold) out.add('input-handling');
  if (hunk.secretMarkers.length > 0) out.add('secrets');
  if (['manifest', 'lockfile', 'workflow'].includes(hunk.fileClass)) {
    out.add('manifest-or-workflow');
  }
  return SECURITY_CATEGORIES.filter((c) => out.has(c));
}

export async function buildRiskMap(
  diff: string,
  opts: BuildRiskMapOpts = {},
): Promise<BuildRiskMapResult> {
  const now = opts.now ?? (() => new Date());
  const threshold = opts.flagThreshold ?? DEFAULT_FLAG_THRESHOLD;
  const criteriaTexts = (opts.acceptanceCriteria ?? []).slice(0, MAX_CRITERIA);

  // Stage 0.
  const s0 = runStage0(diff);
  const fileByPath = new Map(s0.files.map((f) => [f.path, f]));

  // Stage 1.
  const refs: StructuralHunkRef[] = s0.hunks
    .filter((h) => !h.synthetic)
    .map((h) => ({
      id: h.id,
      file: h.file,
      fileClass: h.fileClass,
      startLine: h.startLine,
      endLine: h.endLine,
      text: h.text,
    }));
  const facts = await collectStructural(refs, opts.structural ?? unavailableStructuralProvider);

  // Stage 2.
  const testsChangedFor = (file: string, id: string): string[] => {
    const named = fileByPath.get(file)?.nameMatchedTests ?? [];
    const referenced = (facts.get(id)?.referencingTests ?? []).filter((t) =>
      s0.changedTestFiles.includes(t),
    );
    return [...new Set([...named, ...referenced])];
  };
  const judgmentInputs: HunkJudgmentInput[] = s0.hunks.map((h) => ({
    id: h.id,
    file: safeText(h.file, 1024),
    fileClass: h.fileClass,
    header: h.header,
    text: h.text,
    testsChanged: h.fileClass === 'test' || testsChangedFor(h.file, h.id).length > 0,
  }));
  const s2 = await runStage2(
    {
      hunks: judgmentInputs,
      skipIds: new Set(s0.hunks.filter((h) => h.synthetic).map((h) => h.id)),
      changedFiles: s0.changedFiles.map((p) => safeText(p, 1024)),
      redactedDiff: redactSecrets(diff),
      acceptanceCriteria: criteriaTexts.map((t) => safeText(t, 2000)),
    },
    opts.judgment,
    {
      ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.maxHunksPerRequest ? { maxHunksPerRequest: opts.maxHunksPerRequest } : {}),
    },
  );

  // Assemble and rank.
  const screenClean = s2.injectionScreen.status === 'clean';
  const unranked: Omit<RiskMapHunk, 'rank'>[] = s0.hunks.map((h) => {
    const f = facts.get(h.id);
    // A diff whose injection screen is not clean (suspicious, or could not be evaluated)
    // cannot be trusted to have steered its own per-hunk judgment: rank every hunk as
    // unjudged and high risk.
    const j = screenClean ? s2.judged.get(h.id) : undefined;
    const structural: RiskMapHunk['structural'] = f
      ? {
          status: 'available',
          callers: [...f.callers],
          callees: [...f.callees],
          referencingTests: [...f.referencingTests],
          schemaConsumers: [...f.schemaConsumers],
          coverageLines: [...f.coverageLines],
        }
      : { status: 'unavailable' };
    return {
      id: h.id,
      file: safeText(h.file, 1024),
      header: safeText(h.header, 512),
      startLine: h.startLine,
      endLine: Math.max(h.startLine, h.endLine),
      fileClass: h.fileClass,
      testsChanged: h.fileClass === 'test' || testsChangedFor(h.file, h.id).length > 0,
      ...(f ? { symbols: [...f.symbols] } : {}),
      structural,
      judged: j !== undefined,
      ...(j ? { nouls: j.nouls, judgmentScore: j.score } : {}),
      riskScore: j && f ? Math.min(1, Math.max(0, j.score)) : 1,
      flags: flagsFor(h, j?.nouls.authAuthz, j?.nouls.inputHandling, threshold),
      secretMarkers: h.secretMarkers,
    };
  });
  const order = new Map(unranked.map((h, i) => [h.id, i]));
  const hunks: RiskMapHunk[] = [...unranked]
    .sort(
      (a, b) =>
        b.riskScore - a.riskScore ||
        (b.judgmentScore ?? 1) - (a.judgmentScore ?? 1) ||
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    )
    .map((h, i) => ({ ...h, rank: i + 1 }));

  const changedSourceFiles: RiskMapSourceFile[] = s0.files
    .filter((f) => f.fileClass === 'source')
    .map((f) => {
      const tests = new Set(f.nameMatchedTests);
      for (const h of s0.hunks) {
        if (h.file === f.path) for (const t of testsChangedFor(h.file, h.id)) tests.add(t);
      }
      return { path: safeText(f.path, 1024), changedTests: [...tests].sort() };
    });

  const criteria: RiskMapCriterion[] = s2.criteria;
  const map: ReviewRiskMap = {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    stats: s0.stats,
    flags: s0.flags,
    ...(opts.verifications ? { verifications: opts.verifications } : {}),
    changedFiles: s0.changedFiles.map((p) => safeText(p, 1024)),
    changedTestFiles: s0.changedTestFiles.map((p) => safeText(p, 1024)),
    changedSourceFiles,
    hunks,
    criteria,
    acCoverage: s2.acCoverage,
    injectionScreen: s2.injectionScreen,
    routing: s2.routing,
  };

  const check = validateReviewRiskMap(map);
  if (!check.valid) {
    const detail = (check.errors ?? [])
      .slice(0, 5)
      .map((e) => `${e.path || '/'} ${e.message}`)
      .join('; ');
    throw new Error(`review risk map failed schema validation: ${detail}`);
  }

  const artifactsDir = resolve(
    opts.artifactsDir ?? process.env.ARTIFACTS_DIR ?? resolve(process.cwd(), '_artifacts'),
  );
  const runId = (opts.runId ?? opts.taskId ?? 'run').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  const dir = join(artifactsDir, RISK_MAP_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${runId}.json`);
  await writeFile(filePath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  return { map, filePath };
}
