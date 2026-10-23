/**
 * Ingest explanatory markdown sections as knowledge entries (RFC-0053 OQ-4,
 * AISDLC-782). Explanation, history and rationale leave the always-loaded prefix
 * and arrive just-in-time; each `##` section becomes one entry carrying trunk,
 * source (file#anchor) and decay.
 */
import { dump } from '../util/yaml.js';
import { hashValue, parseEntryFile, validateEntryFields } from './entry.js';
import type { Ontology } from './ontology.js';

export interface IngestOptions {
  /** Repo-relative path of the markdown file; becomes the entry source. */
  source: string;
  observed: string;
  trunk?: string;
  decay?: string;
  /** Only ingest sections whose heading is listed; default is every `##` section. */
  headings?: string[];
}

export interface IngestedEntry {
  /** Path under the tracked knowledge root: `<trunk>/<slug>.md`. */
  path: string;
  text: string;
}

export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Split markdown into `##` sections (heading text and body). */
export function splitSections(markdown: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) {
      if (cur) out.push({ heading: cur.heading, body: cur.lines.join('\n').trim() });
      cur = { heading: m[1], lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) out.push({ heading: cur.heading, body: cur.lines.join('\n').trim() });
  return out;
}

export function sectionsToEntries(
  markdown: string,
  ontology: Ontology,
  opts: IngestOptions,
): IngestedEntry[] {
  const trunk = opts.trunk ?? 'process';
  const decay = opts.decay ?? 'durable';
  const entries: IngestedEntry[] = [];
  for (const s of splitSections(markdown)) {
    if (opts.headings && !opts.headings.includes(s.heading)) continue;
    if (!s.body) continue;
    const slug = slugify(s.heading);
    const value = s.body
      .split(/\n\s*\n/)[0]
      .replace(/\s+/g, ' ')
      .trim();
    const fields = {
      id: `section-${slugify(opts.source)}-${slug}`,
      trunk,
      type: 'fact',
      value,
      confidence: 0.7,
      authority: 'inferred',
      scope: 'internal',
      source: `${opts.source}#${slug}`,
      observed: opts.observed,
      decay,
      relations: [],
      contentHash: hashValue(value),
    };
    const errors = validateEntryFields(fields, ontology);
    if (errors.length > 0) throw new Error(`section '${s.heading}': ${errors.join('; ')}`);
    const text = `---\n${dump(fields)}---\n\n${s.body}\n`;
    // Round-trip guard: what we write must parse back as an entry.
    if (!('fields' in parseEntryFile(text))) throw new Error(`section '${s.heading}': unparseable`);
    entries.push({ path: `${trunk}/${slug}.md`, text });
  }
  return entries;
}
