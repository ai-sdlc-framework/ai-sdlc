/**
 * The note for an automatic CI round (AISDLC-1231): the failed step, the tail of its log and
 * the head sha, so the executor starts the round knowing what broke. The log is capped by
 * line count and bytes and stripped of ANSI; a log that cannot be fetched is said so in the
 * note and the round is still ordered.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MAX_NOTE_CHARS } from '../dispatch/resume.js';
import { resolveGateRunId } from './gate-run.js';
import type { CommandRunner } from './types.js';

export const CI_LOG_TAIL_LINES = 60;
export const CI_LOG_TAIL_BYTES = 2500;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Last lines of a log, ANSI-stripped, capped by line count and by bytes (keeping the end). */
export function tailLog(raw: string, maxLines = CI_LOG_TAIL_LINES, maxBytes = CI_LOG_TAIL_BYTES) {
  const lines = raw
    .replace(ANSI_RE, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '');
  let text = lines.slice(-maxLines).join('\n');
  if (Buffer.byteLength(text) > maxBytes) {
    text = Buffer.from(text).subarray(-maxBytes).toString('utf-8').replace(/^�+/, '');
  }
  return text;
}

interface RunJob {
  name?: string;
  conclusion?: string;
  steps?: { name?: string; conclusion?: string }[];
}

/** `job / step` of every failed step in a `gh run view --json jobs` payload. */
function failedSteps(stdout: string): string[] {
  try {
    const jobs = (JSON.parse(stdout) as { jobs?: RunJob[] }).jobs ?? [];
    return jobs.flatMap((j) => {
      if (j.conclusion !== 'failure') return [];
      const steps = (j.steps ?? []).filter((s) => s.conclusion === 'failure');
      return steps.length > 0
        ? steps.map((s) => `${j.name ?? 'job'} / ${s.name ?? 'step'}`)
        : [j.name ?? 'job'];
    });
  } catch {
    return [];
  }
}

export interface CiNoteInput {
  pr: number;
  headSha: string;
  failingLine?: string;
  /** ISO time of the previous automatic round; only a ruling comment newer than it counts. */
  since?: string;
  /** Lower-case logins whose comments may carry a ruling; absent or empty means rulings are ignored. */
  trustedLogins?: ReadonlySet<string>;
}

const RULING_FIRST_LINE_RE = /^(Planner ruling\b|PLANNER REPAIR ORDER\b)/;

interface PrComment {
  body?: string;
  createdAt?: string;
  author?: { login?: string };
}

/**
 * AISDLC-1238: the newest planner ruling or repair order on the PR (a comment whose first
 * line starts `Planner ruling` or `PLANNER REPAIR ORDER`) newer than `since`. Never throws.
 */
export function findPlannerRuling(
  run: CommandRunner,
  cwd: string,
  pr: number,
  since?: string,
  trustedLogins?: ReadonlySet<string>,
): string | undefined {
  if (!trustedLogins || trustedLogins.size === 0) return undefined;
  try {
    const r = run('gh', ['pr', 'view', String(pr), '--json', 'comments'], { cwd });
    if (r.status !== 0) return undefined;
    const comments = (JSON.parse(r.stdout) as { comments?: PrComment[] }).comments ?? [];
    const sinceMs = since ? Date.parse(since) : Number.NaN;
    const hits = comments
      .filter((c) => {
        if (!trustedLogins.has((c.author?.login ?? '').toLowerCase())) return false;
        const first = (c.body ?? '').trim().split('\n')[0] ?? '';
        if (!RULING_FIRST_LINE_RE.test(first)) return false;
        if (Number.isNaN(sinceMs)) return true;
        const at = Date.parse(c.createdAt ?? '');
        return !Number.isNaN(at) && at > sinceMs;
      })
      .sort((a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''));
    return hits.at(-1)?.body?.trim();
  } catch {
    return undefined;
  }
}

/** Build the note text. Never throws; a missing run or log is stated in the note. */
export function buildCiRoundNote(run: CommandRunner, cwd: string, input: CiNoteInput): string {
  const { headSha } = input;
  const runId = resolveGateRunId(run, cwd, headSha);
  let steps: string[] = [];
  let log: string | undefined;
  if (runId) {
    const jobs = run('gh', ['run', 'view', runId, '--json', 'jobs'], { cwd });
    if (jobs.status === 0) steps = failedSteps(jobs.stdout);
    const l = run('gh', ['run', 'view', runId, '--log-failed'], { cwd });
    if (l.status === 0 && l.stdout.trim() !== '') log = tailLog(l.stdout);
  }
  const stepName = steps.length > 0 ? steps.join('; ') : (input.failingLine ?? 'unknown step');
  const ruling = findPlannerRuling(run, cwd, input.pr, input.since, input.trustedLogins);
  if (ruling) {
    const lead = `${ruling.slice(0, MAX_NOTE_CHARS - 400)}\nFailed step: ${stepName} (PR #${input.pr}, head ${headSha}).`;
    const room = MAX_NOTE_CHARS - lead.length - 12;
    const tail = log && room > 100 ? `\nLog tail:\n${tailLog(log, CI_LOG_TAIL_LINES, room)}` : '';
    return `${lead}${tail}`.slice(0, MAX_NOTE_CHARS);
  }
  const head = [
    `CI failed on PR #${input.pr} at head ${headSha}. Failed step: ${stepName}.`,
    'Fix the cause in this round, run the full verification, and push.',
  ];
  const body = log
    ? `Log tail:\n${log}`
    : 'The failing log could not be fetched; read it with `gh run view --log-failed` for this head.';
  let note = `${head.join(' ')}\n${body}`;
  if (note.length > MAX_NOTE_CHARS) {
    const room = MAX_NOTE_CHARS - head.join(' ').length - 40;
    note = `${head.join(' ')}\nLog tail:\n${tailLog(log ?? '', CI_LOG_TAIL_LINES, Math.max(room, 200)).slice(-Math.max(room, 200))}`;
  }
  return note.slice(0, MAX_NOTE_CHARS);
}

/** Write the note under the board directory (the only place `--note-file` reads) and return its path. */
export function writeCiRoundNote(boardDir: string, pr: number, headSha: string, note: string) {
  const dir = path.join(boardDir, 'landing', String(pr));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ci-round-${headSha.slice(0, 12)}.md`);
  writeFileSync(file, note, 'utf-8');
  return file;
}
