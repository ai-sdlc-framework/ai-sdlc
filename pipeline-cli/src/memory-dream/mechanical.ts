/**
 * Mechanical pass of a memory dream (AISDLC-729). No model calls.
 *
 * @module memory-dream/mechanical
 */

import { type IndexEntry, type Note, stemOf } from './notes.js';

export interface LinkFinding {
  file: string;
  link: string;
  /** Unambiguous replacement stem, when one exists. */
  repairTo?: string;
  ambiguous?: string[];
}

export interface MechanicalFindings {
  unindexed: string[];
  indexMissingFile: string[];
  invalidFrontmatter: Array<{ file: string; problems: string[] }>;
  danglingLinks: LinkFinding[];
  repairableLinks: LinkFinding[];
  longIndexLines: Array<{ file: string; length: number }>;
  totalLinks: number;
}

export interface LinkTarget {
  file: string;
  name: string;
}

const LINK_RE = /\[\[([^\]\n]+)\]\]/g;

export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function targetKeys(t: LinkTarget): string[] {
  const stem = stemOf(t.file);
  const keys = [normalizeKey(stem), normalizeKey(t.name)];
  const bare = stem.replace(/^(feedback|project|user|reference)[_-]/, '');
  keys.push(normalizeKey(bare));
  return keys;
}

export function linkText(raw: string): string {
  return raw.split('|')[0].split('#')[0].trim();
}

export type LinkResolution =
  | { kind: 'ok' }
  | { kind: 'repair'; stem: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'dangling' };

export function resolveLink(raw: string, targets: LinkTarget[]): LinkResolution {
  const text = linkText(raw);
  if (targets.some((t) => stemOf(t.file) === text || t.name === text)) return { kind: 'ok' };
  const key = normalizeKey(text);
  if (!key) return { kind: 'dangling' };
  const hits = targets.filter((t) => targetKeys(t).includes(key));
  const stems = [...new Set(hits.map((h) => stemOf(h.file)))];
  if (stems.length === 1) return { kind: 'repair', stem: stems[0] };
  if (stems.length > 1) return { kind: 'ambiguous', candidates: stems };
  return { kind: 'dangling' };
}

/** Rewrites unambiguous `[[x]]` links in `body`; returns the new body. */
export function repairLinks(
  body: string,
  targets: LinkTarget[],
  redirects: Map<string, string> = new Map(),
): string {
  return body.replace(LINK_RE, (whole, raw: string) => {
    const text = linkText(raw);
    const redirect = redirects.get(text) ?? redirects.get(normalizeKey(text));
    if (redirect) return `[[${redirect}]]`;
    const r = resolveLink(raw, targets);
    return r.kind === 'repair' ? `[[${r.stem}]]` : whole;
  });
}

export function analyzeLinks(
  notes: Array<{ file: string; body: string }>,
  targets: LinkTarget[],
): Pick<MechanicalFindings, 'danglingLinks' | 'repairableLinks' | 'totalLinks'> {
  const danglingLinks: LinkFinding[] = [];
  const repairableLinks: LinkFinding[] = [];
  let totalLinks = 0;
  for (const n of notes) {
    for (const m of n.body.matchAll(LINK_RE)) {
      totalLinks++;
      const r = resolveLink(m[1], targets);
      if (r.kind === 'repair') {
        repairableLinks.push({ file: n.file, link: linkText(m[1]), repairTo: r.stem });
      } else if (r.kind === 'ambiguous') {
        danglingLinks.push({ file: n.file, link: linkText(m[1]), ambiguous: r.candidates });
      } else if (r.kind === 'dangling') {
        danglingLinks.push({ file: n.file, link: linkText(m[1]) });
      }
    }
  }
  return { danglingLinks, repairableLinks, totalLinks };
}

export function toTargets(notes: Array<{ file: string; name: string }>): LinkTarget[] {
  return notes.map((n) => ({ file: n.file, name: n.name }));
}

export function runMechanicalPass(
  notes: Note[],
  index: IndexEntry[],
  opts: { indexLineMax: number },
): MechanicalFindings {
  const files = new Set(notes.map((n) => n.file));
  const indexed = new Set(index.map((e) => e.file));
  return {
    unindexed: notes.filter((n) => !indexed.has(n.file)).map((n) => n.file),
    indexMissingFile: index.filter((e) => !files.has(e.file)).map((e) => e.file),
    invalidFrontmatter: notes
      .filter((n) => n.problems.length > 0)
      .map((n) => ({ file: n.file, problems: n.problems })),
    longIndexLines: index
      .filter((e) => e.line.length > opts.indexLineMax)
      .map((e) => ({ file: e.file, length: e.line.length })),
    ...analyzeLinks(notes, toTargets(notes)),
  };
}
