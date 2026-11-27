/**
 * Ingest adapters (RFC-0053, AISDLC-774): project what ai-sdlc already structures
 * (decision catalog, RFCs, review logs, orchestrator events, backlog tasks) into
 * knowledge entries. Repo artifacts become `specialist` with the proof set to the
 * source id; no adapter ever writes `canonical`. Re-ingest is idempotent by
 * contentHash, and a changed source rewrites the entry with a `supersedes` record.
 *
 * The `generated` source (AISDLC-1436) reads a JSON array of generator records from a
 * file the operator names with `--file`. It is outside the enterprise gate. A record is
 * `specialist` only when its proof is an `allowlisted-command:` proof whose id is in the
 * configured allowlist (the command is not run here); any other proof is `inferred`.
 * Invalid records are reported and skipped instead of failing the run.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { reviewsLedgerPath, reviewsLedgerRelativePath } from '../attestation/reviews-ledger.js';
import { projectAll } from '../decisions/projection.js';
import { appendKnowledgeEvent } from './log.js';
import type { Actor } from './promote.js';
import { hashValue, parseEntryFile, validateEntryFields } from './entry.js';
import { openKnowledgeStore, type KnowledgeBackendSelection } from './knowledge-store.js';
import type { Ontology } from './ontology.js';
import { slugify } from './ingest-sections.js';

export const INGEST_SOURCES = [
  'decisions',
  'rfc',
  'reviews',
  'events',
  'tasks',
  'generated',
] as const;
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
  /** Defaults to `specialist`; the `generated` source sets it per record. */
  authority?: 'specialist' | 'inferred';
}

export interface IngestResult {
  created: number;
  updated: number;
  unchanged: number;
}

export interface IngestOptions extends KnowledgeBackendSelection {
  projectDir: string;
  trackedRootAbs: string;
  ontology: Ontology;
  observed: string;
  eventsFile?: string;
  /** JSON array of generator records; required by the `generated` source. */
  generatedFile?: string;
  /** Command allowlist (`knowledge.allowlistedCommands`); read by the `generated` source. */
  allowlistedCommands?: Record<string, string[]>;
  /** Where skipped-record reports go; defaults to stderr. */
  report?: (line: string) => void;
  /** Recorded on the `superseded` events this ingest writes. */
  actor: Actor;
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

const GENERATED_FIELDS = ['id', 'trunk', 'type', 'value', 'source', 'proof'] as const;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const COMMAND_PROOF = 'allowlisted-command:';

/** `specialist` only for an `allowlisted-command:<id>::<expected>` proof with `<id>` allowlisted. */
export function generatedAuthority(
  proof: string,
  allowlist: Record<string, string[]> = {},
): 'specialist' | 'inferred' {
  if (!proof.startsWith(COMMAND_PROOF)) return 'inferred';
  const rest = proof.slice(COMMAND_PROOF.length);
  const i = rest.indexOf('::');
  if (i <= 0 || rest.slice(i + 2) === '') return 'inferred';
  return Object.hasOwn(allowlist, rest.slice(0, i)) ? 'specialist' : 'inferred';
}

function generatedCandidates(o: IngestOptions): Candidate[] {
  if (!o.generatedFile) throw new Error('--source generated requires --file <path>');
  const report = o.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  const parsed: unknown = JSON.parse(readFileSync(o.generatedFile, 'utf-8'));
  if (!Array.isArray(parsed)) throw new Error(`${o.generatedFile}: expected a JSON array`);
  const out: Candidate[] = [];
  parsed.forEach((raw: unknown, index) => {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const bad = GENERATED_FIELDS.filter((k) => typeof r[k] !== 'string' || r[k] === '');
    if (bad.length > 0) {
      report(`skipped record ${index}: missing or non-string ${bad.join(', ')}`);
      return;
    }
    const s = r as Record<(typeof GENERATED_FIELDS)[number], string>;
    if (!SAFE_ID.test(s.id)) {
      report(`skipped record ${index}: id '${s.id}' must match ${String(SAFE_ID)}`);
      return;
    }
    const c: Candidate = {
      id: s.id,
      trunk: s.trunk,
      type: s.type,
      value: oneLine(s.value),
      decay: 'seasonal',
      source: s.source,
      proof: s.proof,
      body: '',
      authority: generatedAuthority(s.proof, o.allowlistedCommands),
    };
    const errors = validateEntryFields(candidateFields(c, o.observed), o.ontology);
    if (errors.length > 0) {
      report(`skipped record ${index} (${s.id}): ${errors.join('; ')}`);
      return;
    }
    out.push(c);
  });
  return out;
}

const ADAPTERS: Record<IngestSource, (o: IngestOptions) => Candidate[]> = {
  decisions: decisionCandidates,
  rfc: rfcCandidates,
  reviews: reviewCandidates,
  events: eventCandidates,
  tasks: taskCandidates,
  generated: generatedCandidates,
};

/** Build the entries an adapter would write. Authority is `specialist` unless the candidate sets it. */
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
    authority: c.authority ?? 'specialist',
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
  const store = openKnowledgeStore({
    backend: o.backend,
    backendModule: o.backendModule,
    trackedRoot: o.trackedRootAbs,
  });
  for (const c of collectCandidates(kind, o)) {
    const fields = candidateFields(c, o.observed);
    const errors = validateEntryFields(fields, o.ontology);
    if (errors.length > 0) throw new Error(`${c.id}: ${errors.join('; ')}`);
    const path = join(c.trunk, `${c.id}.md`);
    const prior = store.get(c.id, { scope: 'tracked', path });
    if (prior && prior.fields.contentHash === fields.contentHash) {
      result.unchanged++;
      continue;
    }
    if (prior) {
      fields.supersedes = `${c.id}@${String(prior.fields.contentHash)}`;
      appendKnowledgeEvent(o.trackedRootAbs, {
        event: 'superseded',
        id: c.id,
        by: o.actor.by,
        principal: o.actor.principal,
        detail: String(fields.supersedes),
      });
    }
    const body = `\n${c.body}${c.body ? '\n' : ''}`;
    if (store.put({ fields, body }, { scope: 'tracked', path }).created) result.created++;
    else result.updated++;
  }
  return result;
}
