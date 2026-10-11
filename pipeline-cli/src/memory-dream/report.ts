/**
 * Dream report model and Markdown rendering (AISDLC-729).
 * Reports name files and counts; they never copy note bodies.
 *
 * @module memory-dream/report
 */

import type { Budgets, Metrics } from './build-output.js';
import type { MechanicalFindings } from './mechanical.js';
import type { LowConfidenceMerge, PlanDisposition, SynthesisUsage } from './synthesis.js';
import type { Proposal } from './transcripts.js';

export interface DreamReport {
  version: 1;
  startedAt: string;
  dryRun: boolean;
  model: string;
  inputDir: string;
  outputDir?: string;
  budgets: Budgets;
  mechanical: MechanicalFindings;
  /** What the synthesis pass would look at (dry-run) or looked at (run). */
  synthesisInput: { notes: number; bytes: number; estimatedInputTokens: number };
  dispositions: PlanDisposition[];
  outputs: Array<{ file: string; sources: string[]; kind: 'new' | 'rewritten' }>;
  lowConfidence: LowConfidenceMerge[];
  validatorRepairs: string[];
  proposals: Proposal[];
  proposalsAdded: boolean;
  before: Metrics;
  after?: Metrics;
  budgetsMet?: {
    index: boolean;
    notes: boolean;
    overBudgetNotes: string[];
    truncatedIndexLines: number;
  };
  usage?: SynthesisUsage;
  warnings: string[];
  suggestion?: string;
}

export function indexSuggestion(m: Metrics, b: Budgets): string | undefined {
  if (m.indexLines <= b.indexMaxLines && m.indexBytes <= b.indexMaxBytes) return undefined;
  return `The loaded memory index is ${m.indexLines} lines / ${m.indexBytes} bytes (budget ${b.indexMaxLines} lines / ${b.indexMaxBytes} bytes): consider /ai-sdlc memory-dream.`;
}

const metricRow = (label: string, b: number, a: number | undefined): string =>
  `| ${label} | ${b} | ${a ?? '-'} |`;

export function renderReport(r: DreamReport): string {
  const L: string[] = [];
  L.push(`# Memory dream report${r.dryRun ? ' (dry run)' : ''}`, '');
  L.push(`- Started: ${r.startedAt}`, `- Input: ${r.inputDir}`);
  if (r.outputDir) L.push(`- Output (unapplied): ${r.outputDir}`);
  L.push(`- Model: ${r.model}`, '');
  L.push('## Numbers', '', '| Metric | Before | After |', '| --- | --- | --- |');
  L.push(metricRow('Notes', r.before.notes, r.after?.notes));
  L.push(metricRow('Archived notes', r.before.archivedNotes, r.after?.archivedNotes));
  L.push(metricRow('Index lines', r.before.indexLines, r.after?.indexLines));
  L.push(metricRow('Index bytes', r.before.indexBytes, r.after?.indexBytes));
  L.push(metricRow('Dangling links', r.before.danglingLinks, r.after?.danglingLinks));
  L.push(metricRow('Note bytes', r.before.totalBytes, r.after?.totalBytes), '');
  if (r.budgetsMet) {
    L.push('## Budgets', '');
    L.push(
      `- Index (<= ${r.budgets.indexMaxLines} lines and <= ${r.budgets.indexMaxBytes} bytes): ${r.budgetsMet.index ? 'met' : 'NOT met'}`,
    );
    L.push(
      `- Notes (<= ${r.budgets.noteMaxBytes} bytes each): ${r.budgetsMet.notes ? 'met' : `NOT met (${r.budgetsMet.overBudgetNotes.join(', ')})`}`,
    );
    if (r.budgetsMet.truncatedIndexLines > 0)
      L.push(
        `- Index lines truncated to ${r.budgets.indexLineMax} characters: ${r.budgetsMet.truncatedIndexLines}`,
      );
    L.push('');
  }
  const m = r.mechanical;
  L.push('## Mechanical pass', '');
  L.push(
    `- Notes missing from the index: ${m.unindexed.length}${m.unindexed.length ? ` (${m.unindexed.join(', ')})` : ''}`,
  );
  L.push(
    `- Index entries for missing files: ${m.indexMissingFile.length}${m.indexMissingFile.length ? ` (${m.indexMissingFile.join(', ')})` : ''}`,
  );
  L.push(
    `- Links total: ${m.totalLinks}; repairable: ${m.repairableLinks.length}; dangling: ${m.danglingLinks.length}`,
  );
  for (const d of m.danglingLinks)
    L.push(
      `  - ${d.file}: [[${d.link}]]${d.ambiguous ? ` ambiguous between ${d.ambiguous.join(', ')}` : ''}`,
    );
  L.push(`- Invalid or missing frontmatter: ${m.invalidFrontmatter.length}`);
  for (const f of m.invalidFrontmatter) L.push(`  - ${f.file}: ${f.problems.join(', ')}`);
  L.push(`- Index lines over ${r.budgets.indexLineMax} characters: ${m.longIndexLines.length}`, '');
  L.push('## Synthesis input', '');
  L.push(
    `${r.synthesisInput.notes} notes, ${r.synthesisInput.bytes} bytes, about ${r.synthesisInput.estimatedInputTokens} input tokens (estimate).`,
    '',
  );
  if (r.dryRun) {
    L.push(
      'Dry run: only the mechanical pass ran. No model call was made and nothing was written.',
      '',
    );
  } else {
    L.push('## Dispositions', '', '| Input note | Disposition | Detail |', '| --- | --- | --- |');
    for (const d of r.dispositions) {
      const detail = d.action === 'merged' ? `into ${d.into}` : (d.reason ?? '');
      L.push(`| ${d.input} | ${d.action} | ${detail.replace(/\|/g, '/')} |`);
    }
    L.push('', '## New or rewritten notes', '');
    if (r.outputs.length === 0) L.push('None.');
    for (const o of r.outputs) L.push(`- ${o.file} (${o.kind}) from ${o.sources.join(', ')}`);
    L.push('', '## Low-confidence merges', '');
    if (r.lowConfidence.length === 0) L.push('None.');
    for (const l of r.lowConfidence)
      L.push(
        `- ${l.inputs.join(' + ')} into ${l.into}: ${l.applied ? 'applied' : 'left unmerged'} (${l.reason})`,
      );
    L.push('', '## Validator repairs', '');
    if (r.validatorRepairs.length === 0) L.push('None.');
    for (const v of r.validatorRepairs) L.push(`- ${v}`);
    L.push('', '## Cost', '');
    const u = r.usage;
    if (u) {
      L.push(
        `Model ${u.model}, ${u.calls} call(s): input ${u.inputTokens}, cache write (5m) ${u.cacheWrite5mTokens}, cache read ${u.cacheReadTokens}, output ${u.outputTokens} tokens. Terms as in docs/operations/usage-ledger.md.${u.costUsd !== undefined ? ` Reported cost ${u.costUsd} USD.` : ''}`,
      );
    } else L.push('No model call was made.');
    L.push('');
  }
  if (r.proposals.length > 0) {
    L.push(
      '## Transcript proposals',
      '',
      `${r.proposalsAdded ? 'Added to the output (explicit flag).' : 'Proposals only; NOT added to the output.'} Transcripts are untrusted: review each one.`,
      '',
    );
    for (const p of r.proposals) L.push(`- ${p.file} (${p.type}): ${p.name}. Source: ${p.reason}`);
    L.push('');
  }
  if (r.warnings.length > 0) {
    L.push('## Warnings', '');
    for (const w of r.warnings) L.push(`- ${w}`);
    L.push('');
  }
  if (r.suggestion) L.push(`> ${r.suggestion}`, '');
  return `${L.join('\n')}\n`;
}
