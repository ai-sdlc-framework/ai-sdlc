/**
 * Backlog.md tracker adapter for the admission composite.
 *
 * Backlog.md tasks are markdown files in `backlog/tasks/` (open) or
 * `backlog/completed/` (archived). They carry YAML frontmatter
 * (`id`, `title`, `status`, `priority`, `labels`, `references`,
 * `created_date`, `updated_date`, `assignee`) plus a body that
 * includes a `## Acceptance Criteria` checklist.
 *
 * This module:
 *   1. Parses a task file into `BacklogTaskSnapshot`
 *   2. Maps the snapshot onto `AdmissionInput` using the conventions
 *      in the bug-fix doc (priority:p* / size:[SML] / track:* / etc.)
 *   3. Emits `qualityFlags` for "Done with unchecked ACs" zombie closes
 *
 * The GitHub-shaped `mapIssueToPriorityInput` in `admission-score.ts`
 * is left intact; the dispatch sits in `cli-admit`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PriorityInput, QualityFlag } from '@ai-sdlc/reference';
import type { AdmissionInput } from './admission-score.js';

// ── Snapshot shape ──────────────────────────────────────────────────

export interface BacklogAcceptanceCriterion {
  index: number;
  text: string;
  checked: boolean;
}

export interface BacklogTaskSnapshot {
  /** Canonical id from the YAML frontmatter, e.g. "AISDLC-42". */
  id: string;
  /** Numeric tail of the id, e.g. 42. */
  numericId: number;
  title: string;
  description: string;
  status: string;
  priority: string | null;
  labels: string[];
  createdDate: string;
  updatedDate: string;
  createdBy?: string;
  acceptanceCriteria: BacklogAcceptanceCriterion[];
  references: string[];
  /** Filesystem path the snapshot was read from. */
  sourcePath?: string;
}

// ── Parser ──────────────────────────────────────────────────────────

/**
 * Parse a Backlog.md task markdown file into `BacklogTaskSnapshot`.
 * Throws when the frontmatter is missing or malformed.
 */
export function parseBacklogTask(content: string, sourcePath?: string): BacklogTaskSnapshot {
  const fm = extractFrontmatter(content);
  if (!fm) throw new Error('Backlog task is missing YAML frontmatter');

  const id = String(fm.id ?? '').trim();
  if (!id) throw new Error('Backlog task frontmatter is missing `id`');
  const numericId = parseNumericId(id);

  const labels = normaliseLabels(fm.labels);
  const references = normaliseStringArray(fm.references);
  const description = extractSection(content, 'Description');
  const acceptanceCriteria = extractAcceptanceCriteria(content);

  return {
    id,
    numericId,
    title: String(fm.title ?? '').trim(),
    description,
    status: String(fm.status ?? '').trim(),
    priority: fm.priority == null ? null : String(fm.priority).trim(),
    labels,
    createdDate: String(fm.created_date ?? '').trim(),
    updatedDate: String(fm.updated_date ?? '').trim(),
    createdBy: fm.created_by ? String(fm.created_by).trim() : undefined,
    acceptanceCriteria,
    references,
    sourcePath,
  };
}

/**
 * Resolve a Backlog task id ("AISDLC-42" or "task-42") to a snapshot
 * by searching the `backlog/tasks/` and `backlog/completed/` directories
 * under `backlogRoot` (typically the project root).
 */
export function loadBacklogTaskFromRoot(
  backlogRoot: string,
  id: string,
): BacklogTaskSnapshot | undefined {
  const idLower = id.toLowerCase();
  const candidates = [
    join(backlogRoot, 'backlog', 'tasks'),
    join(backlogRoot, 'backlog', 'completed'),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (
        !entry.toLowerCase().startsWith(`${idLower} `) &&
        !entry.toLowerCase().startsWith(`${idLower}.`)
      ) {
        continue;
      }
      const path = join(dir, entry);
      const content = readFileSync(path, 'utf-8');
      return parseBacklogTask(content, path);
    }
  }
  return undefined;
}

// ── Frontmatter helpers (no external YAML dep — handle the subset
// Backlog.md emits: scalar, sequence, null, "Done"-quoted strings) ──

function extractFrontmatter(content: string): Record<string, unknown> | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  return parseSimpleYaml(match[1]);
}

function parseSimpleYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    let value: string = m[2].trim();
    if (value === '' || value === '[]') {
      // Inline empty or block sequence follows.
      const seq: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        seq.push(
          lines[j]
            .replace(/^\s+-\s+/, '')
            .trim()
            .replace(/^['"]|['"]$/g, ''),
        );
        j++;
      }
      out[key] = value === '[]' ? [] : seq.length > 0 ? seq : '';
      i = j;
      continue;
    }
    // Strip wrapping quotes if present.
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
    i++;
  }
  return out;
}

function normaliseLabels(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

function normaliseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return [];
}

function parseNumericId(id: string): number {
  const m = id.match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function extractSection(content: string, name: string): string {
  // Match `## <name>` until the next `## ` header or end of file.
  const re = new RegExp(`##\\s+${name}[\\s\\S]*?(?=\\n##\\s|$)`, 'i');
  const match = content.match(re);
  if (!match) return '';
  return match[0].replace(/^##\s+\S+\s*/i, '').trim();
}

function extractAcceptanceCriteria(content: string): BacklogAcceptanceCriterion[] {
  const section = extractSection(content, 'Acceptance Criteria');
  if (!section) return [];
  const out: BacklogAcceptanceCriterion[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+\[([ x])\]\s+(?:#(\d+)\s+)?(.*)$/i);
    if (!m) continue;
    out.push({
      index: m[2] ? Number(m[2]) : out.length + 1,
      checked: m[1].toLowerCase() === 'x',
      text: m[3].trim(),
    });
  }
  return out;
}

// ── Snapshot → AdmissionInput ──────────────────────────────────────

export interface BacklogMappingOptions {
  /**
   * Soul-tracks dictionary loaded from `.ai-sdlc/soul-tracks.json`,
   * mapping `track:*` labels to a soul-alignment floor in [0, 1].
   * Absent/empty → only `source:rfc` / `source:spec` /
   * `governance` / `compliance` lift soulAlignment.
   */
  soulTracks?: Record<string, number>;
  /**
   * Maintainer logins for `OWNER` author-association mapping. When
   * `createdBy` matches one of these, AdmissionInput.authorAssociation
   * is set to OWNER (which feeds the trust-based signal floors in
   * the existing GitHub mapper).
   */
  maintainers?: string[];
}

const DEFAULT_SOUL_TRACKS: Record<string, number> = {
  // Generic defaults — projects override via `.ai-sdlc/soul-tracks.json`.
  'track:ops': 0.55,
  'track:infra': 0.55,
  'track:hygiene': 0.55,
};

export interface BacklogAdmissionMapping {
  /** Admission input shaped like the GitHub mapper output. */
  input: AdmissionInput;
  /**
   * PriorityInput overrides derived from Backlog conventions
   * (priority:p* / size:[SML] / track:* / source:* / AC progress).
   * Pass these to `computeAdmissionComposite` via
   * `AdmissionCompositeOptions.priorityInputOverrides` so they
   * win over the GitHub-shaped label heuristic.
   */
  priorityInputOverrides: Partial<PriorityInput>;
  /** Quality flags surfaced for renderers (zombie close, etc). */
  qualityFlags: QualityFlag[];
}

/**
 * Map a Backlog snapshot onto an `AdmissionInput` plus the
 * `PriorityInput` overrides cli-admit feeds into the composite.
 * The label-mapping table is the load-bearing piece; tests in
 * `backlog-adapter.test.ts` pin each row.
 */
export function mapBacklogTaskToAdmissionInput(
  snap: BacklogTaskSnapshot,
  options: BacklogMappingOptions = {},
): BacklogAdmissionMapping {
  const labels = snap.labels;
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));
  const tracks = { ...DEFAULT_SOUL_TRACKS, ...(options.soulTracks ?? {}) };

  const authorAssociation: AdmissionInput['authorAssociation'] =
    snap.createdBy && options.maintainers?.includes(snap.createdBy) ? 'OWNER' : 'MEMBER';

  // Defaults — overridden below as labels apply.
  let soulAlignment = 0.5;
  let bugSeverity: number | undefined;
  let complexity: number | undefined;

  // ── Priority labels → explicit priority signal ────────────────
  // priority:p0..p3 + frontmatter `priority:` field.
  let explicitPriority: number | undefined;
  if (labelSet.has('priority:p0')) explicitPriority = 1.0;
  else if (labelSet.has('priority:p1')) explicitPriority = 0.75;
  else if (labelSet.has('priority:p2')) explicitPriority = 0.5;
  else if (labelSet.has('priority:p3')) explicitPriority = 0.25;
  else if (snap.priority?.toLowerCase() === 'high') explicitPriority = 0.75;
  else if (snap.priority?.toLowerCase() === 'medium') explicitPriority = 0.5;
  else if (snap.priority?.toLowerCase() === 'low') explicitPriority = 0.25;

  // ── Size labels → complexity ─────────────────────────────────
  if (labelSet.has('size:s')) complexity = 2;
  else if (labelSet.has('size:m')) complexity = 5;
  else if (labelSet.has('size:l')) complexity = 7;
  else if (labelSet.has('size:xl')) complexity = 9;
  // Otherwise derive from AC count below.

  // ── Soul-alignment signals ────────────────────────────────────
  if (labelSet.has('source:rfc') || labelSet.has('source:spec')) {
    soulAlignment = Math.max(soulAlignment, 0.9);
  }
  if (labelSet.has('governance') || labelSet.has('compliance')) {
    soulAlignment = Math.max(soulAlignment, 0.85);
  }
  for (const label of labels) {
    const key = label.toLowerCase();
    if (key.startsWith('track:') && tracks[key] !== undefined) {
      soulAlignment = Math.max(soulAlignment, tracks[key]);
    }
  }

  // ── Bug-class labels ──────────────────────────────────────────
  if (labelSet.has('bug') || labelSet.has('regression') || labelSet.has('defect')) {
    bugSeverity = 3;
  }
  if (labelSet.has('security') || labelSet.has('vulnerability')) {
    bugSeverity = 5;
    soulAlignment = Math.max(soulAlignment, 0.7);
  }
  if (labelSet.has('critical') || labelSet.has('p0')) {
    bugSeverity = Math.max(bugSeverity ?? 0, 5);
  }

  // ── AC progress → complexity proxy + quality flags ───────────
  const acTotal = snap.acceptanceCriteria.length;
  const acChecked = snap.acceptanceCriteria.filter((a) => a.checked).length;
  const acProgress = acTotal === 0 ? null : acChecked / acTotal;

  if (complexity === undefined && acTotal > 0) {
    // 1 AC → 1.6, 5 ACs → 4, 9 ACs → 6.4, 13 ACs → 8.8 (capped at 9).
    complexity = Math.min(1 + acTotal * 0.6, 9);
  }

  const qualityFlags: QualityFlag[] = [];
  let defectRiskFactor: number | undefined;
  const isZombieClose =
    snap.status.toLowerCase() === 'done' && acTotal > 0 && acProgress !== null && acProgress < 1.0;
  if (isZombieClose) {
    const severity: QualityFlag['severity'] = acProgress! < 0.5 ? 'high' : 'medium';
    qualityFlags.push({
      kind: 'unchecked-acs-on-done',
      detail: `${acTotal - acChecked}/${acTotal} ACs unchecked`,
      severity,
    });
    defectRiskFactor = severity === 'high' ? 0.3 : 0.15;
  }

  // ── Demand / drift / consensus heuristics ─────────────────────
  let demandSignal: number | undefined;
  let competitiveDrift = 0;
  for (const label of labels) {
    const key = label.toLowerCase();
    if (key.startsWith('source:') && key.includes('-tonight')) {
      demandSignal = Math.max(demandSignal ?? 0, 0.7);
      competitiveDrift += 0.2;
    }
    if (key === 'scope:v1-ship' || key === 'scope:v1') {
      competitiveDrift += 0.6;
    }
  }
  competitiveDrift = Math.min(competitiveDrift, 1);

  // teamConsensus: someone is on the hook.
  const teamConsensus = snap.createdBy ? 0.4 : undefined;

  // builderConviction: anchored in references? Multiple references to
  // existing files = author did the homework.
  const builderConviction =
    snap.references.length >= 2 ? 0.7 : snap.references.length === 1 ? 0.6 : undefined;

  // commentCount / reactionCount have no Backlog analog yet; default 0.
  const reactionCount = 0;
  const commentCount = 0;

  // Construct the body the existing scorer expects (Description +
  // Acceptance Criteria) — preserves the GitHub mapper's complexity
  // regex for callers that bypass the Backlog mapping path.
  const renderedBody = buildAdmissionBody(snap, complexity);

  const input: AdmissionInput = {
    issueNumber: snap.numericId,
    title: snap.title,
    body: renderedBody,
    labels,
    reactionCount,
    commentCount,
    createdAt: normaliseIsoDate(snap.createdDate),
    authorAssociation,
    authorLogin: snap.createdBy,
  };

  const priorityInputOverrides: Partial<PriorityInput> = {};
  if (soulAlignment !== 0.5) priorityInputOverrides.soulAlignment = soulAlignment;
  if (bugSeverity !== undefined) priorityInputOverrides.bugSeverity = bugSeverity;
  if (complexity !== undefined) priorityInputOverrides.complexity = complexity;
  if (explicitPriority !== undefined) priorityInputOverrides.explicitPriority = explicitPriority;
  if (demandSignal !== undefined) priorityInputOverrides.demandSignal = demandSignal;
  if (competitiveDrift > 0) priorityInputOverrides.competitiveDrift = competitiveDrift;
  if (teamConsensus !== undefined) priorityInputOverrides.teamConsensus = teamConsensus;
  if (builderConviction !== undefined) priorityInputOverrides.builderConviction = builderConviction;
  if (defectRiskFactor !== undefined) priorityInputOverrides.defectRiskFactor = defectRiskFactor;
  if (qualityFlags.length > 0) priorityInputOverrides.qualityFlags = qualityFlags;

  return { input, priorityInputOverrides, qualityFlags };
}

function buildAdmissionBody(snap: BacklogTaskSnapshot, complexity: number | undefined): string {
  const parts: string[] = [];
  if (snap.description) parts.push(snap.description);
  if (complexity !== undefined) {
    parts.push('');
    parts.push('### Complexity');
    parts.push('');
    parts.push(String(Math.round(complexity)));
  }
  if (snap.acceptanceCriteria.length > 0) {
    parts.push('');
    parts.push('### Acceptance Criteria');
    parts.push('');
    for (const ac of snap.acceptanceCriteria) {
      parts.push(`- [${ac.checked ? 'x' : ' '}] ${ac.text}`);
    }
  }
  return parts.join('\n');
}

function normaliseIsoDate(raw: string): string {
  // Backlog stores '2026-03-08 22:27' — coerce to ISO for `cli-admit`.
  if (!raw) return new Date().toISOString();
  if (/T\d{2}:\d{2}/.test(raw)) return raw;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[\s T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (!m) return new Date(raw).toISOString();
  return `${m[1]}T${m[2]}:${m[3] ?? '00'}Z`;
}

// ── Soul-tracks loader ─────────────────────────────────────────────

/**
 * Load `.ai-sdlc/soul-tracks.json` from the given config root.
 * Format: `{ "track:enchantment": 0.85, "track:reflect": 0.85, ... }`.
 * Missing file → empty object (caller falls back to DEFAULT_SOUL_TRACKS).
 */
export function loadSoulTracks(configRoot: string): Record<string, number> {
  const path = join(configRoot, '.ai-sdlc', 'soul-tracks.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && value >= 0 && value <= 1) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}
