/**
 * The transcript leaves a staged review produces, and where their files live.
 *
 * One leaf per model-running stage transcript: one for the planner, one per probe that
 * ran a model, one for the synthesizer. Probes that were refused or skipped never ran a
 * model and have no transcript, so they have no leaf. Every leaf is emitted by
 * `cli-attestation emit-leaf --reviewer staged-review --stage <stage>`, which writes
 * `stage` only when given one and forces the plan and execute leaves to zero findings and
 * `verdictApproved: false`; only the synthesize leaf carries the verdict.
 *
 * @module review-staged/leaves
 */

import { join } from 'node:path';
import { STAGED_REVIEWER_NAME, type StagedLeafStage } from '../attestation/merkle.js';
import { safeSegment } from './run-store.js';
import { DEFAULT_HARNESS } from '../harness-defaults.js';

export interface LeafManifestEntry {
  stage: StagedLeafStage;
  /** `emit-leaf --reviewer`: the same name for every leaf of the set. */
  reviewer: typeof STAGED_REVIEWER_NAME;
  /** The probe the leaf covers, for an execute leaf. */
  probeId?: string;
  transcriptPath: string;
  verdictPath: string;
  harness: string;
  model: string;
}

export interface ExecuteLeafSource {
  probeId: string;
  transcriptPath: string;
  verdictPath: string;
  harness: string;
  model: string;
}

function dirs(
  worktreePath: string,
  taskId: string,
): { transcriptDir: string; verdictDir: string; id: string } {
  return {
    transcriptDir: join(worktreePath, '.ai-sdlc', 'transcripts', taskId.toLowerCase()),
    verdictDir: join(worktreePath, '.ai-sdlc', 'verdicts'),
    id: taskId.toLowerCase(),
  };
}

/** Where the execute stage writes each probe's transcript and verdict stub. */
export function executeTranscriptFiles(
  worktreePath: string,
  taskId: string,
): {
  transcriptDir: string;
  verdictDir: string;
  forProbe: (probeId: string) => { transcriptPath: string; verdictPath: string };
} {
  const d = dirs(worktreePath, taskId);
  return {
    transcriptDir: d.transcriptDir,
    verdictDir: d.verdictDir,
    forProbe: (probeId) => {
      const seg = safeSegment(probeId);
      return {
        transcriptPath: join(d.transcriptDir, `${STAGED_REVIEWER_NAME}-execute-${seg}.jsonl`),
        verdictPath: join(d.verdictDir, `${STAGED_REVIEWER_NAME}-execute-${seg}-${d.id}.json`),
      };
    },
  };
}

export interface BuildLeafManifestOpts {
  worktreePath: string;
  taskId: string;
  executeLeaves: readonly ExecuteLeafSource[];
  plannerModel?: string;
  synthesizerModel?: string;
}

/**
 * The leaves to emit, in order: planner, probes, synthesizer. The planner's and the
 * synthesizer's transcripts are persisted by the coordinator under their agent names
 * (`review-planner`, `review-synthesizer`), exactly as for the other reviewers.
 */
export function buildLeafManifest(opts: BuildLeafManifestOpts): {
  leaves: LeafManifestEntry[];
  synthesizeVerdictPath: string;
} {
  const d = dirs(opts.worktreePath, opts.taskId);
  const synthesizeVerdictPath = join(d.verdictDir, `${STAGED_REVIEWER_NAME}-${d.id}.json`);
  const leaves: LeafManifestEntry[] = [
    {
      stage: 'plan',
      reviewer: STAGED_REVIEWER_NAME,
      transcriptPath: join(d.transcriptDir, 'review-planner.jsonl'),
      verdictPath: join(d.verdictDir, `review-planner-${d.id}.json`),
      harness: DEFAULT_HARNESS,
      model: opts.plannerModel ?? 'unrouted',
    },
    ...[...opts.executeLeaves]
      .sort((a, b) => (a.probeId < b.probeId ? -1 : 1))
      .map((e): LeafManifestEntry => ({
        stage: 'execute',
        reviewer: STAGED_REVIEWER_NAME,
        probeId: e.probeId,
        transcriptPath: e.transcriptPath,
        verdictPath: e.verdictPath,
        harness: e.harness,
        model: e.model,
      })),
    {
      stage: 'synthesize',
      reviewer: STAGED_REVIEWER_NAME,
      transcriptPath: join(d.transcriptDir, 'review-synthesizer.jsonl'),
      verdictPath: synthesizeVerdictPath,
      harness: DEFAULT_HARNESS,
      model: opts.synthesizerModel ?? 'unrouted',
    },
  ];
  return { leaves, synthesizeVerdictPath };
}
