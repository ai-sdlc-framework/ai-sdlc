/**
 * Transcript usage audit (AISDLC-765).
 *
 * Reads Claude Code transcripts (`~/.claude/projects/<project>/*.jsonl`,
 * including subagent transcripts) and answers where API-weight spend went:
 * by project, loop body, role and model. It flags the two leaks the
 * 2026-10-08 token audit found: idle noop-wakeup turns (a polling loop paying
 * for a full context read just to sleep again) and sessions whose context
 * grew past a threshold with no `/clear`.
 *
 * Pure parsing and aggregation live here with every filesystem touch behind
 * `listTranscripts` / `readTranscript`, so tests never read a real home dir.
 * Costs are estimates at API list-price weight, not billed amounts. Nothing
 * from a transcript's text is ever printed.
 *
 * @module usage/audit
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { now as clockNow } from '../clock.js';
import { basename, join, sep } from 'node:path';

export const DEFAULT_CONTEXT_THRESHOLD = 200_000;
/** A turn with at most this many model calls that ends in a noop wakeup is idle. */
export const IDLE_MAX_CALLS = 4;

interface Price {
  in: number;
  cr: number;
  cw: number;
  out: number;
}

/** API list price, USD per million tokens, chosen by model family. */
export function priceFor(model: string): Price {
  if (/opus|fable|mythos/i.test(model)) return { in: 15, cr: 1.5, cw: 18.75, out: 75 };
  if (/haiku/i.test(model)) return { in: 1, cr: 0.1, cw: 1.25, out: 5 };
  return { in: 3, cr: 0.3, cw: 3.75, out: 15 };
}

export interface AuditTurn {
  project: string;
  loop: string;
  role: string;
  model: string;
  cost: number;
  calls: number;
  idle: boolean;
}

export interface AuditSession {
  project: string;
  file: string;
  maxContext: number;
  hadClear: boolean;
  isSubagent: boolean;
}

export interface ParsedTranscript {
  turns: AuditTurn[];
  session: AuditSession;
}

export interface ParseOptions {
  project: string;
  file: string;
  isSubagent: boolean;
  sinceMs: number;
}

interface OpenTurn {
  loop: string;
  cost: number;
  calls: number;
  noop: boolean;
  models: Map<string, number>;
}

/** Project label from a `~/.claude/projects` directory name. */
export function projectLabel(dirName: string): string {
  return (
    dirName.replace(/^-Users-[^-]+-Documents-dev-/, '').replace(/^-Users-[^-]+-/, '') || dirName
  );
}

/** Parse one transcript's JSONL lines into turns and a session summary. */
export function parseTranscript(lines: Iterable<string>, opts: ParseOptions): ParsedTranscript {
  const turns: AuditTurn[] = [];
  let loop = '';
  let agentType = '';
  let turn: OpenTurn | null = null;
  let maxContext = 0;
  let hadClear = false;

  const flush = (): void => {
    if (!turn || turn.calls === 0) {
      turn = null;
      return;
    }
    let model = '?';
    let best = -1;
    for (const [m, n] of turn.models) {
      if (n > best) {
        best = n;
        model = m;
      }
    }
    turns.push({
      project: opts.project,
      loop: opts.isSubagent ? '(subagent)' : turn.loop || 'interactive/other',
      role: opts.isSubagent ? agentType || 'subagent' : 'main',
      model,
      cost: turn.cost,
      calls: turn.calls,
      idle: turn.noop && turn.calls <= IDLE_MAX_CALLS,
    });
    turn = null;
  };
  const open = (): OpenTurn => ({ loop, cost: 0, calls: 0, noop: false, models: new Map() });

  for (const line of lines) {
    if (!line) continue;
    let j: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      j = JSON.parse(line) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    } catch {
      continue;
    }
    if (typeof j.agentType === 'string' && !agentType) agentType = j.agentType;
    if (j.type === 'user') {
      const raw = j.message?.content;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      if (/<command-name>\/clear<\/command-name>/.test(text)) hadClear = true;
      const m =
        /<command-name>\/?(ai-sdlc:[a-z-]+|loop|schedule)<\/command-name>/.exec(text) ??
        /\/ai-sdlc[: ]([a-z-]+)/.exec(text);
      if (m) loop = m[1].replace(/^ai-sdlc:/, '');
      if (!/tool_result/.test(text.slice(0, 200))) {
        flush();
        turn = open();
      }
      continue;
    }
    const usage = j.message?.usage;
    if (j.type !== 'assistant' || !usage) continue;
    const t = Date.parse(j.timestamp);
    if (!(t > opts.sinceMs)) continue;
    turn ??= open();
    const model: string = j.message.model || '?';
    const p = priceFor(model);
    const input = usage.input_tokens || 0;
    const cr = usage.cache_read_input_tokens || 0;
    const cw = usage.cache_creation_input_tokens || 0;
    turn.cost += (input * p.in + cr * p.cr + cw * p.cw + (usage.output_tokens || 0) * p.out) / 1e6;
    turn.calls++;
    turn.models.set(model, (turn.models.get(model) ?? 0) + 1);
    maxContext = Math.max(maxContext, input + cr + cw);
    const content: unknown[] = Array.isArray(j.message.content) ? j.message.content : [];
    if (
      content.some((b) => {
        const blk = b as { type?: string; name?: string; input?: { noop?: unknown } };
        return blk.type === 'tool_use' && blk.name === 'ScheduleWakeup' && !!blk.input?.noop;
      })
    ) {
      turn.noop = true;
    }
  }
  flush();
  return {
    turns,
    session: {
      project: opts.project,
      file: opts.file,
      maxContext,
      hadClear,
      isSubagent: opts.isSubagent,
    },
  };
}

export interface GroupRow {
  key: string;
  cost: number;
  idleCost: number;
  turns: number;
  idleTurns: number;
  calls: number;
}

export type GroupDimension = 'project' | 'loop' | 'role' | 'model';
export const GROUP_DIMENSIONS: readonly GroupDimension[] = ['project', 'loop', 'role', 'model'];

export function groupTurns(turns: readonly AuditTurn[], dim: GroupDimension): GroupRow[] {
  const map = new Map<string, GroupRow>();
  for (const t of turns) {
    const key = t[dim];
    let r = map.get(key);
    if (!r) {
      r = { key, cost: 0, idleCost: 0, turns: 0, idleTurns: 0, calls: 0 };
      map.set(key, r);
    }
    r.cost += t.cost;
    r.turns++;
    r.calls += t.calls;
    if (t.idle) {
      r.idleCost += t.cost;
      r.idleTurns++;
    }
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export interface AuditReport {
  days: number;
  totalCost: number;
  idleCost: number;
  idleTurns: number;
  turns: number;
  groups: Record<GroupDimension, GroupRow[]>;
  bigContextSessions: AuditSession[];
}

export function buildReport(
  parsed: readonly ParsedTranscript[],
  days: number,
  contextThreshold = DEFAULT_CONTEXT_THRESHOLD,
): AuditReport {
  const turns = parsed.flatMap((p) => p.turns);
  const groups = Object.fromEntries(
    GROUP_DIMENSIONS.map((d) => [d, groupTurns(turns, d)]),
  ) as Record<GroupDimension, GroupRow[]>;
  return {
    days,
    totalCost: turns.reduce((s, t) => s + t.cost, 0),
    idleCost: turns.filter((t) => t.idle).reduce((s, t) => s + t.cost, 0),
    idleTurns: turns.filter((t) => t.idle).length,
    turns: turns.length,
    groups,
    bigContextSessions: parsed
      .map((p) => p.session)
      .filter((s) => !s.isSubagent && !s.hadClear && s.maxContext > contextThreshold)
      .sort((a, b) => b.maxContext - a.maxContext),
  };
}

const usd = (n: number): string => `$${n.toFixed(0)}`;
const pct = (n: number, d: number): string => `${((100 * n) / Math.max(d, 1e-9)).toFixed(0)}%`;

function table(title: string, rows: readonly GroupRow[], total: number, limit: number): string[] {
  const out = [`${title}`];
  for (const r of rows.slice(0, limit)) {
    out.push(
      `  ${r.key.padEnd(34)} ${usd(r.cost).padStart(7)} ${pct(r.cost, total).padStart(5)}  idle ${usd(r.idleCost).padStart(6)} (${r.idleTurns}/${r.turns} turns)`,
    );
  }
  return out;
}

/** Plain-text audit: the four group tables plus the flags. */
export function renderAudit(report: AuditReport, limit = 12): string {
  const lines = [
    `${report.days}-day usage audit: ${usd(report.totalCost)} API-weight over ${report.turns} turns.`,
    `Idle (noop-wakeup turns of ${IDLE_MAX_CALLS} calls or fewer): ${usd(report.idleCost)} = ${pct(report.idleCost, report.totalCost)} of spend, ${report.idleTurns} turns.`,
    '',
  ];
  for (const dim of GROUP_DIMENSIONS) {
    lines.push(...table(`By ${dim}`, report.groups[dim], report.totalCost, limit), '');
  }
  lines.push(
    `Sessions with context over threshold and no clear: ${report.bigContextSessions.length}`,
  );
  for (const s of report.bigContextSessions.slice(0, limit)) {
    lines.push(
      `  ${s.project} ${basename(s.file)} peak context ${(s.maxContext / 1000).toFixed(0)}k`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Paste-ready weekly digest: short plain text, no tables, no markup. */
export function renderDigest(report: AuditReport): string {
  const top = (dim: GroupDimension): string => {
    const r = report.groups[dim][0];
    return r ? `${r.key} (${usd(r.cost)}, ${pct(r.cost, report.totalCost)})` : 'none';
  };
  const idleLoops = report.groups.loop
    .filter((r) => r.idleCost > 0)
    .sort((a, b) => b.idleCost - a.idleCost)
    .slice(0, 3)
    .map((r) => `${r.key} ${usd(r.idleCost)}`);
  const lines = [
    `Weekly usage digest (last ${report.days} days)`,
    `Total API-weight spend: ${usd(report.totalCost)}.`,
    `Idle polling: ${usd(report.idleCost)} (${pct(report.idleCost, report.totalCost)} of spend) across ${report.idleTurns} noop-wakeup turns.`,
    idleLoops.length > 0
      ? `Worst idle loops: ${idleLoops.join(', ')}.`
      : 'No idle polling loops found.',
    `Top project: ${top('project')}.`,
    `Top loop: ${top('loop')}.`,
    `Top role: ${top('role')}.`,
    `Top model: ${top('model')}.`,
    report.bigContextSessions.length > 0
      ? `${report.bigContextSessions.length} session(s) ran over the context threshold with no clear; largest peaked at ${(report.bigContextSessions[0].maxContext / 1000).toFixed(0)}k tokens in ${report.bigContextSessions[0].project}.`
      : 'No sessions ran over the context threshold without a clear.',
    report.idleCost > 0
      ? 'Action: stop or lengthen the interval of any loop listed under worst idle loops.'
      : 'Action: none.',
  ];
  return `${lines.join('\n')}\n`;
}

export interface TranscriptFile {
  path: string;
  project: string;
  isSubagent: boolean;
}

export function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Transcripts under `root` modified since `sinceMs`. Unreadable entries are skipped. */
export function listTranscripts(root: string, sinceMs: number): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try {
          if (statSync(p).mtimeMs <= sinceMs) continue;
        } catch {
          continue;
        }
        out.push({
          path: p,
          project: projectLabel(p.slice(root.length + 1).split(sep)[0]),
          isSubagent: p.includes(`${sep}subagents${sep}`) || /^agent-/.test(e.name),
        });
      }
    }
  };
  walk(root);
  return out;
}

export interface AuditDeps {
  projectsDir?: string;
  now?: () => Date;
  listTranscripts?: typeof listTranscripts;
  readTranscript?: (path: string) => string;
}

/** Run the audit over the transcripts of the last `days` days. */
export function runAudit(
  days: number,
  contextThreshold: number,
  deps: AuditDeps = {},
): AuditReport {
  const sinceMs = (deps.now?.() ?? clockNow()).getTime() - days * 86_400_000;
  const root = deps.projectsDir ?? defaultProjectsDir();
  const read = deps.readTranscript ?? ((p: string): string => readFileSync(p, 'utf8'));
  const parsed: ParsedTranscript[] = [];
  for (const f of (deps.listTranscripts ?? listTranscripts)(root, sinceMs)) {
    let text: string;
    try {
      text = read(f.path);
    } catch {
      continue;
    }
    parsed.push(
      parseTranscript(text.split('\n'), {
        project: f.project,
        file: f.path,
        isSubagent: f.isSubagent,
        sinceMs,
      }),
    );
  }
  return buildReport(parsed, days, contextThreshold);
}
