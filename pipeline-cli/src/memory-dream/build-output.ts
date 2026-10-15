/**
 * Applies a validated plan to an input folder, in memory (AISDLC-729).
 * Produces the output folder content: notes, archive, rebuilt index, and the
 * before/after numbers. Writes nothing.
 *
 * @module memory-dream/build-output
 */

import {
  type IndexEntry,
  type MemoryFolder,
  formatIndexLine,
  parseNote,
  serializeNote,
  stemOf,
} from './notes.js';
import { analyzeLinks, repairLinks, toTargets } from './mechanical.js';
import type { Plan } from './synthesis.js';
import type { Proposal } from './transcripts.js';

export interface Metrics {
  notes: number;
  archivedNotes: number;
  indexLines: number;
  indexBytes: number;
  danglingLinks: number;
  totalBytes: number;
}

export interface Budgets {
  indexMaxLines: number;
  indexMaxBytes: number;
  noteMaxBytes: number;
  indexLineMax: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  indexMaxLines: 40,
  indexMaxBytes: 8 * 1024,
  noteMaxBytes: 4 * 1024,
  indexLineMax: 200,
};

export interface BuiltOutput {
  files: Map<string, string>;
  archive: Map<string, string>;
  indexText: string;
  after: Metrics;
  truncatedIndexLines: number;
  overBudgetNotes: string[];
  rewritten: Array<{ file: string; sources: string[]; kind: 'new' | 'rewritten' }>;
}

function truncate(line: string, max: number): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

export function measureFolder(
  files: Map<string, string>,
  archive: Map<string, string>,
  indexText: string,
): Metrics {
  const all = [...files, ...archive].map(([f, c]) => parseNote(f, c));
  const lines = indexText.split('\n').filter((l) => l.trim().length > 0);
  return {
    notes: files.size,
    archivedNotes: archive.size,
    indexLines: lines.length,
    indexBytes: Buffer.byteLength(indexText),
    danglingLinks: analyzeLinks(all, toTargets(all)).danglingLinks.length,
    totalBytes: [...files.values()].reduce((s, c) => s + Buffer.byteLength(c), 0),
  };
}

export function buildOutput(
  input: MemoryFolder,
  plan: Plan,
  budgets: Budgets,
  proposals: Proposal[] = [],
): BuiltOutput {
  const disp = new Map(plan.dispositions.map((d) => [d.input, d]));
  const outputs = new Map(plan.outputs.map((o) => [o.file, o]));
  const redirects = new Map<string, string>();
  for (const d of plan.dispositions) {
    if (d.action === 'merged' && d.into) {
      const n = input.notes.find((x) => x.file === d.input);
      redirects.set(stemOf(d.input), stemOf(d.into));
      if (n) redirects.set(n.name, stemOf(d.into));
    }
  }

  // Raw content of every surviving note, before link repair.
  const rootRaw = new Map<string, string>();
  const archiveRaw = new Map<string, string>();
  for (const n of input.notes) {
    const d = disp.get(n.file);
    if (outputs.has(n.file)) continue;
    if (d?.action === 'archived') archiveRaw.set(n.file, n.raw);
    else if (!d || d.action === 'kept') rootRaw.set(n.file, n.raw);
  }
  const rewritten: BuiltOutput['rewritten'] = [];
  for (const o of plan.outputs) {
    rootRaw.set(
      o.file,
      serializeNote({
        name: o.name,
        description: o.description,
        type: o.type,
        sources: o.sources,
        body: o.body,
      }),
    );
    rewritten.push({
      file: o.file,
      sources: o.sources,
      kind: input.notes.some((n) => n.file === o.file) ? 'rewritten' : 'new',
    });
  }
  for (const p of proposals) {
    rootRaw.set(
      p.file,
      serializeNote({
        name: p.name,
        description: p.description,
        type: p.type,
        sources: ['transcript'],
        extra: { origin: 'transcript-proposal' },
        body: p.body,
      }),
    );
    rewritten.push({ file: p.file, sources: ['transcript'], kind: 'new' });
  }

  // Link repair against everything that survives (root and archive).
  const parsedAll = [...rootRaw, ...archiveRaw].map(([f, c]) => parseNote(f, c));
  const targets = toTargets(parsedAll);
  const fix = (raw: string): string => repairLinks(raw, targets, redirects);
  const files = new Map([...rootRaw].map(([f, c]) => [f, fix(c)]));
  const archive = new Map([...archiveRaw].map(([f, c]) => [f, fix(c)]));

  // Index: keep the input order, then append anything new or unindexed.
  const parsedRoot = new Map([...files].map(([f, c]) => [f, parseNote(f, c)]));
  const oldEntries = new Map<string, IndexEntry>(input.index.map((e) => [e.file, e]));
  const order = [
    ...input.index.map((e) => e.file).filter((f) => parsedRoot.has(f)),
    ...[...parsedRoot.keys()].filter((f) => !oldEntries.has(f)),
  ];
  let truncated = 0;
  const lines = order.map((f) => {
    const n = parsedRoot.get(f)!;
    const old = oldEntries.get(f);
    const hook = plan.indexLines[f] ?? old?.hook ?? n.description;
    const line = formatIndexLine(old?.title ?? n.name, f, hook);
    const cut = truncate(line, budgets.indexLineMax);
    if (cut !== line) truncated++;
    return cut;
  });
  const indexText = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  return {
    files,
    archive,
    indexText,
    after: measureFolder(files, archive, indexText),
    truncatedIndexLines: truncated,
    overBudgetNotes: [...parsedRoot.values()]
      .filter((n) => n.bytes > budgets.noteMaxBytes)
      .map((n) => n.file),
    rewritten,
  };
}

export function measureInput(input: MemoryFolder): Metrics {
  const files = new Map(input.notes.map((n) => [n.file, n.raw]));
  const m = measureFolder(files, new Map(), input.indexText);
  m.indexLines = input.indexText.split('\n').filter((l) => l.trim().length > 0).length;
  return m;
}
