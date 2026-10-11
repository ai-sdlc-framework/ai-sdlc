/**
 * `memory-dream run` (AISDLC-729): mechanical pass, model synthesis pass,
 * validated output folder beside the input, and a report. The input folder is
 * only ever read.
 *
 * @module memory-dream/run
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Budgets, buildOutput, measureInput } from './build-output.js';
import { now } from '../clock.js';
import { runMechanicalPass } from './mechanical.js';
import { INDEX_FILE, readMemoryFolder } from './notes.js';
import { type DreamReport, indexSuggestion, renderReport } from './report.js';
import {
  EMPTY_USAGE,
  type Plan,
  type Synthesizer,
  addUsage,
  buildSynthesisPrompt,
  estimateTokens,
  extractJson,
  validatePlan,
} from './synthesis.js';
import {
  buildMiningPrompt,
  collectTranscriptText,
  parseProposals,
  type Proposal,
} from './transcripts.js';

export interface RunOptions {
  memoryDir: string;
  model: string;
  instructions?: string;
  dryRun: boolean;
  budgets: Budgets;
  allowLowConfidence?: boolean;
  mineTranscriptsDir?: string;
  addProposals?: boolean;
  synthesizer: Synthesizer;
  now?: Date;
}

export interface RunMeta {
  version: 1;
  startedAt: string;
  inputDir: string;
  /** file -> sha256 of every input note at run start. */
  snapshot: Record<string, string>;
}

export interface RunResult {
  report: DreamReport;
  markdown: string;
  outputDir?: string;
  reportPaths?: { md: string; json: string };
}

export function outputDirFor(memoryDir: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
  return join(dirname(memoryDir), `${basename(memoryDir)}.dream-${stamp}`);
}

export function metaPathFor(outputDir: string): string {
  return `${outputDir}.meta.json`;
}

const keepAll = (files: string[]): Plan => ({
  dispositions: files.map((f) => ({ input: f, action: 'kept' as const })),
  outputs: [],
  lowConfidence: [],
  indexLines: {},
});

export async function runDream(opts: RunOptions): Promise<RunResult> {
  const at = opts.now ?? now();
  const input = readMemoryFolder(opts.memoryDir);
  const before = measureInput(input);
  const mechanical = runMechanicalPass(input.notes, input.index, {
    indexLineMax: opts.budgets.indexLineMax,
  });
  const inputBytes =
    input.notes.reduce((s, n) => s + n.bytes, 0) + Buffer.byteLength(input.indexText);
  const report: DreamReport = {
    version: 1,
    startedAt: at.toISOString(),
    dryRun: opts.dryRun,
    model: opts.model,
    inputDir: opts.memoryDir,
    budgets: opts.budgets,
    mechanical,
    synthesisInput: {
      notes: input.notes.length,
      bytes: inputBytes,
      estimatedInputTokens: estimateTokens(inputBytes),
    },
    dispositions: [],
    outputs: [],
    lowConfidence: [],
    validatorRepairs: [],
    proposals: [],
    proposalsAdded: false,
    before,
    warnings: [],
    suggestion: indexSuggestion(before, opts.budgets),
  };
  if (opts.dryRun) return { report, markdown: renderReport(report) };

  // Synthesis pass. A failed or unparseable response falls back to keep-all.
  let plan = keepAll(input.notes.map((n) => n.file));
  let usage = EMPTY_USAGE(opts.model);
  try {
    const prompt = buildSynthesisPrompt(
      input.notes,
      input.indexText,
      opts.budgets,
      opts.instructions,
    );
    const res = await opts.synthesizer.synthesize(prompt, opts.model);
    usage = addUsage(usage, res.usage);
    const v = validatePlan(extractJson(res.text), input.notes, {
      allowLowConfidence: opts.allowLowConfidence,
    });
    plan = v.plan;
    report.validatorRepairs = v.repairs;
  } catch (e) {
    report.warnings.push(
      `synthesis failed, output holds the mechanical fixes only: ${(e as Error).message}`,
    );
  }

  // Optional transcript mining: proposals only.
  let proposals: Proposal[] = [];
  if (opts.mineTranscriptsDir) {
    try {
      const text = collectTranscriptText(opts.mineTranscriptsDir);
      const res = await opts.synthesizer.synthesize(
        buildMiningPrompt(input.notes, text),
        opts.model,
      );
      usage = addUsage(usage, res.usage);
      proposals = parseProposals(res.text, new Set(input.notes.map((n) => n.file)));
    } catch (e) {
      report.warnings.push(`transcript mining failed: ${(e as Error).message}`);
    }
  }
  report.proposals = proposals;
  report.proposalsAdded = opts.addProposals === true && proposals.length > 0;

  const built = buildOutput(input, plan, opts.budgets, report.proposalsAdded ? proposals : []);
  report.dispositions = plan.dispositions;
  report.outputs = built.rewritten;
  report.lowConfidence = plan.lowConfidence;
  report.usage = usage;
  report.after = built.after;
  report.budgetsMet = {
    index:
      built.after.indexLines <= opts.budgets.indexMaxLines &&
      built.after.indexBytes <= opts.budgets.indexMaxBytes,
    notes: built.overBudgetNotes.length === 0,
    overBudgetNotes: built.overBudgetNotes,
    truncatedIndexLines: built.truncatedIndexLines,
  };
  report.suggestion = indexSuggestion(built.after, opts.budgets);

  const outputDir = outputDirFor(opts.memoryDir, at);
  report.outputDir = outputDir;
  mkdirSync(outputDir, { recursive: true });
  for (const [f, c] of built.files) writeFileSync(join(outputDir, f), c);
  if (built.archive.size > 0) {
    mkdirSync(join(outputDir, 'archive'), { recursive: true });
    for (const [f, c] of built.archive) writeFileSync(join(outputDir, 'archive', f), c);
  }
  writeFileSync(join(outputDir, INDEX_FILE), built.indexText);
  const meta: RunMeta = {
    version: 1,
    startedAt: report.startedAt,
    inputDir: opts.memoryDir,
    snapshot: Object.fromEntries(input.notes.map((n) => [n.file, n.hash])),
  };
  writeFileSync(metaPathFor(outputDir), JSON.stringify(meta, null, 2));
  const markdown = renderReport(report);
  const reportPaths = { md: `${outputDir}.report.md`, json: `${outputDir}.report.json` };
  writeFileSync(reportPaths.md, markdown);
  writeFileSync(reportPaths.json, JSON.stringify(report, null, 2));
  return { report, markdown, outputDir, reportPaths };
}
