/**
 * Ingest adapters (RFC-0053, AISDLC-774): project what ai-sdlc already structures
 * (decision catalog, RFCs, review logs, orchestrator events, backlog tasks) into
 * knowledge entries. Repo artifacts become `specialist` with the proof set to the
 * source id; no adapter ever writes `canonical`. Re-ingest is idempotent by
 * contentHash, and a changed source rewrites the entry with a `supersedes` record.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { reviewsLedgerPath, reviewsLedgerRelativePath } from '../attestation/reviews-ledger.js';
import { projectAll } from '../decisions/projection.js';
import { dump } from '../util/yaml.js';
import { hashValue, parseEntryFile, validateEntryFields } from './entry.js';
import type { Ontology } from './ontology.js';
import { slugify } from './ingest-sections.js';

export const INGEST_SOURCES = ['decisions', 'rfc', 'reviews', 'events', 'tasks'] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

export interface Candidate {
  id: string;
  trunk: string;
  type: string;
  value: string;
  decay: string;
  /** Repo-relative path (or logical locator) of the origin. */
  source: string;
  /** Source id (DEC-0001, RFC-0053, AISDLC-1, ...). */
  proof: string;
  body: string;
}

export interface IngestResult {
  created: number;
  updated: number;
  unchanged: number;
}

export interface IngestOptions {
  projectDir: string;
  trackedRootAbs: string;
  ontology: Ontology;
  observed: string;
  eventsFile?: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort()
    .map((f) => join(dir, f));
}

function jsonLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      // malformed line: skip
    }
  }
  return out;
}

function frontmatter(file: string): { fields: Record<string, unknown>; body: string } | null {
  const parsed = parseEntryFile(readFileSync(file, 'utf-8'));
  return 'fields' in parsed ? parsed : null;
}

function decisionCandidates(o: IngestOptions): Candidate[] {
  const { decisions } = projectAll({ workDir: o.projectDir });
  return [...decisions.values()].map((d) => {
    const id = d.metadata.id;
    const answered = d.status.answeredOptionId ? `; answered: ${d.status.answeredOptionId}` : '';
    return {
      id: `decision-${slugify(id)}`,
      trunk: 'decisions',
      type: 'decision',
      value: oneLine(`${id}: ${d.spec.summary} [${d.status.lifecycle}${answered}]`),
      decay: 'durable',
      source: '.ai-sdlc/_decisions',
      proof: id,
      body: d.spec.body ?? '',
    };
  });
}

function rfcCandidates(o: IngestOptions): Candidate[] {
  const out: Candidate[] = [];
  for (const file of listFiles(join(o.projectDir, 'spec/rfcs'), '.md')) {
    const fm = frontmatter(file);
    if (!fm || typeof fm.fields.id !== 'string' || !/^RFC-\d+$/.test(fm.fields.id)) continue;
    const rfc = fm.fields.id;
    const source = `spec/rfcs/${file.split('/').pop()}`;
    const lifecycle = String(fm.fields.lifecycle ?? fm.fields.status ?? 'unknown');
    out.push({
      id: `rfc-${slugify(rfc)}`,
      trunk: 'decisions',
      type: 'fact',
      value: oneLine(`${rfc}: ${String(fm.fields.title ?? '')} [${lifecycle}]`),
      decay: 'durable',
      source,
      proof: rfc,
      body: '',
    });
    const oq = /^## Open Questions\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(fm.body);
    if (!oq) continue;
    let label = '';
    for (const para of oq[1].split(/\n\s*\n/)) {
      const q = /^\*\*(OQ-\d+)/.exec(para.trim());
      if (q) label = q[1];
      if (label && /^\*\*Resolution/.test(para.trim())) {
        out.push({
          id: `rfc-${slugify(rfc)}-${slugify(label)}-resolution`,
          trunk: 'decisions',
          type: 'decision',
          value: oneLine(para.replace(/\*\*/g, '')),
          decay: 'durable',
          source: `${source}#open-questions`,
          proof: rfc,
          body: '',
        });
      }
    }
  }
  return out;
}

function reviewCandidates(o: IngestOptions): Candidate[] {
  const out: Candidate[] = [];
  for (const file of listFiles(dirname(reviewsLedgerPath('x', o.projectDir)), '.jsonl')) {
    for (const r of jsonLines(file)) {
      const task = String(r.taskId ?? '');
      if (!task) continue;
      const source = reviewsLedgerRelativePath(task);
      const findings = Array.isArray(r.findings) ? (r.findings as Record<string, unknown>[]) : [];
      const sha = String(r.commitSha ?? '').slice(0, 7);
      out.push({
        id: `review-${slugify(task)}-${slugify(String(r.role ?? 'review'))}-${String(r.iteration ?? 0)}-${sha}`,
        trunk: 'process',
        type: 'fact',
        value: oneLine(
          `${String(r.role ?? 'review')} review of ${task} iteration ${String(r.iteration ?? '?')}: ${String(r.verdict ?? 'unknown')} (${findings.length} findings)`,
        ),
        decay: 'volatile',
        source,
        proof: task,
        body: findings
          .map((f) => `- ${String(f.severity ?? '')}: ${oneLine(String(f.summary ?? ''))}`)
          .join('\n'),
      });
    }
  }
  return out;
}

function eventCandidates(o: IngestOptions): Candidate[] {
  const file = o.eventsFile ?? join(o.projectDir, '.ai-sdlc/_events.jsonl');
  return jsonLines(file)
    .filter((e) => typeof e.type === 'string' && typeof e.timestamp === 'string')
    .map((e) => {
      const issue = typeof e.issueId === 'string' ? e.issueId : 'none';
      const stage = typeof e.stage === 'string' ? ` stage ${e.stage}` : '';
      return {
        id: `event-${slugify(String(e.type))}-${slugify(issue)}-${hashValue(JSON.stringify(e)).slice(0, 8)}`,
        trunk: 'process',
        type: 'fact',
        value: oneLine(`${String(e.type)} for ${issue}${stage} at ${String(e.timestamp)}`),
        decay: 'volatile',
        source: file.startsWith(o.projectDir) ? file.slice(o.projectDir.length + 1) : file,
        proof: issue === 'none' ? String(e.type) : issue,
        body: '',
      };
    });
}

function taskCandidates(o: IngestOptions): Candidate[] {
  const out: Candidate[] = [];
  for (const dir of ['backlog/tasks', 'backlog/completed']) {
    for (const file of listFiles(join(o.projectDir, dir), '.md')) {
      const fm = frontmatter(file);
      if (!fm || typeof fm.fields.id !== 'string') continue;
      const id = fm.fields.id;
      out.push({
        id: `task-${slugify(id)}`,
        trunk: 'process',
        type: 'fact',
        value: oneLine(
          `${id}: ${String(fm.fields.title ?? '')} [${String(fm.fields.status ?? '')}]`,
        ),
        decay: 'seasonal',
        source: `${dir}/${file.split('/').pop()}`,
        proof: id,
        body: '',
      });
    }
  }
  return out;
}

const ADAPTERS: Record<IngestSource, (o: IngestOptions) => Candidate[]> = {
  decisions: decisionCandidates,
  rfc: rfcCandidates,
  reviews: reviewCandidates,
  events: eventCandidates,
  tasks: taskCandidates,
};

/** Build the entries an adapter would write. Authority is always `specialist`. */
export function collectCandidates(kind: IngestSource, o: IngestOptions): Candidate[] {
  return ADAPTERS[kind](o);
}

export function candidateFields(c: Candidate, observed: string): Record<string, unknown> {
  return {
    id: c.id,
    trunk: c.trunk,
    type: c.type,
    value: c.value,
    confidence: 0.8,
    authority: 'specialist',
    scope: 'internal',
    source: c.source,
    observed,
    decay: c.decay,
    relations: [],
    contentHash: hashValue(c.value),
    proof: c.proof,
  };
}

export function ingestSource(kind: IngestSource, o: IngestOptions): IngestResult {
  const result: IngestResult = { created: 0, updated: 0, unchanged: 0 };
  for (const c of collectCandidates(kind, o)) {
    const fields = candidateFields(c, o.observed);
    const errors = validateEntryFields(fields, o.ontology);
    if (errors.length > 0) throw new Error(`${c.id}: ${errors.join('; ')}`);
    const path = join(o.trackedRootAbs, c.trunk, `${c.id}.md`);
    if (existsSync(path)) {
      const prior = parseEntryFile(readFileSync(path, 'utf-8'));
      if ('fields' in prior && prior.fields.contentHash === fields.contentHash) {
        result.unchanged++;
        continue;
      }
      if ('fields' in prior) fields.supersedes = `${c.id}@${String(prior.fields.contentHash)}`;
      result.updated++;
    } else {
      result.created++;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\n${dump(fields)}---\n\n${c.body}${c.body ? '\n' : ''}`);
  }
  return result;
}
