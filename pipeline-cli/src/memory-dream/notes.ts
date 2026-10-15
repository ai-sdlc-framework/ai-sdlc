/**
 * Memory note and index model for `cli-memory-dream` (AISDLC-729).
 *
 * A memory folder holds one Markdown note per fact (frontmatter: `name`,
 * `description`, `metadata.type`) plus an index `MEMORY.md` with one line per
 * note. Nothing here prints note content; callers report file names and counts.
 *
 * @module memory-dream/notes
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const INDEX_FILE = 'MEMORY.md';
export const NOTE_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
/** Types that synthesis may never merge, archive or drop. */
export const PROTECTED_TYPES: readonly string[] = ['user', 'reference'];

export interface Note {
  file: string;
  raw: string;
  bytes: number;
  hash: string;
  name: string;
  description: string;
  type: string;
  sources: string[];
  body: string;
  /** Frontmatter problems; empty when the note is valid. */
  problems: string[];
}

export interface IndexEntry {
  title: string;
  file: string;
  hook: string;
  line: string;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function stemOf(file: string): string {
  return file.replace(/\.md$/i, '');
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* fall through to plain strip */
    }
  }
  return v.replace(/^'(.*)'$/, '$1');
}

function splitSources(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => unquote(s))
    .filter((s) => s.length > 0);
}

export function parseNote(file: string, raw: string): Note {
  const problems: string[] = [];
  const fields: Record<string, string> = {};
  const meta: Record<string, string> = {};
  let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    problems.push('missing frontmatter');
  } else {
    body = m[2];
    let inMeta = false;
    for (const line of m[1].split(/\r?\n/)) {
      const nested = line.match(/^\s+([\w-]+):\s*(.*)$/);
      if (nested && inMeta) {
        meta[nested[1]] = unquote(nested[2]);
        continue;
      }
      const top = line.match(/^([\w-]+):\s*(.*)$/);
      if (!top) continue;
      inMeta = top[1] === 'metadata' && top[2].trim() === '';
      if (!inMeta) fields[top[1]] = unquote(top[2]);
    }
    if (!fields.name) problems.push('missing name');
    if (!fields.description) problems.push('missing description');
    const t = meta.type ?? fields.type;
    if (!t) problems.push('missing type');
    else if (!(NOTE_TYPES as readonly string[]).includes(t)) problems.push(`invalid type "${t}"`);
  }
  return {
    file,
    raw,
    bytes: Buffer.byteLength(raw),
    hash: sha256(raw),
    name: fields.name ?? stemOf(file),
    description: fields.description ?? '',
    type: meta.type ?? fields.type ?? '',
    sources: splitSources(meta.sources ?? fields.sources ?? ''),
    body,
    problems,
  };
}

function oneLine(value: string): string {
  const v = value.replace(/\s+/g, ' ').trim();
  return /[:#"']|^[-[{>|&*!%@`]/.test(v) ? JSON.stringify(v) : v;
}

export function serializeNote(n: {
  name: string;
  description: string;
  type: string;
  sources?: string[];
  extra?: Record<string, string>;
  body: string;
}): string {
  const meta = [`  type: ${oneLine(n.type)}`];
  if (n.sources && n.sources.length > 0) meta.push(`  sources: ${n.sources.join(', ')}`);
  for (const [k, v] of Object.entries(n.extra ?? {})) meta.push(`  ${k}: ${oneLine(v)}`);
  return [
    '---',
    `name: ${oneLine(n.name)}`,
    `description: ${oneLine(n.description)}`,
    'metadata:',
    ...meta,
    '---',
    '',
    n.body.replace(/^\s+/, '').replace(/\s+$/, ''),
    '',
  ].join('\n');
}

const INDEX_RE = /^\s*[-*]\s*\[([^\]]*)\]\(([^)]+)\)\s*(?:[—–-]+\s*(.*))?$/;

export function parseIndex(text: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(INDEX_RE);
    if (m) out.push({ title: m[1], file: m[2], hook: (m[3] ?? '').trim(), line });
  }
  return out;
}

export function formatIndexLine(title: string, file: string, hook: string): string {
  const h = hook.replace(/\s+/g, ' ').trim();
  return h ? `- [${title}](${file}) — ${h}` : `- [${title}](${file})`;
}

export interface MemoryFolder {
  dir: string;
  notes: Note[];
  indexText: string;
  index: IndexEntry[];
}

/** Reads every top-level `*.md` note (except the index) in `dir`. */
export function readMemoryFolder(dir: string): MemoryFolder {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`memory folder not found: ${dir}`);
  }
  const notes = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== INDEX_FILE && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => parseNote(f, readFileSync(join(dir, f), 'utf-8')));
  const indexPath = join(dir, INDEX_FILE);
  const indexText = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '';
  return { dir, notes, indexText, index: parseIndex(indexText) };
}
