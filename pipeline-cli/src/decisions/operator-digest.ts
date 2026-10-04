/**
 * Operator digest of autonomous decisions (AISDLC-703, DEC-0039).
 *
 * Lists the decisions answered since a cutoff with class, chosen option, a
 * one-line rationale and how to reverse each, plus timeboxed decisions that are
 * still inside their override window. Read-only: the operator overrides with the
 * existing catalog commands (`answer`, `extend`).
 *
 * Class comes from an explicit `Class: a|b|c` line in the decision body when the
 * planner recorded one; otherwise it is derived: a timebox means class (b), no
 * timebox means class (a). Class (c) is never derived, it must be stated.
 *
 * @module decisions/operator-digest
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readDecisionEvents, resolveDecisionsDir } from './event-log.js';
import type {
  AutoExpiredEvent,
  DecisionEvent,
  DecisionOpenedEvent,
  OperatorAnsweredEvent,
} from './decision-record.js';

export type DecisionClass = 'a' | 'b' | 'c';

export interface DigestAnswered {
  decisionId: string;
  decisionClass: DecisionClass;
  summary: string;
  chosenOptionId: string;
  chosenDescription: string;
  rationale: string;
  answeredAt: string;
  answeredBy: string;
  reverse: string;
  /** Detect-and-report notes for the operator; never a block. */
  flags: string[];
}

export interface DigestPending {
  decisionId: string;
  decisionClass: DecisionClass;
  summary: string;
  fallbackOptionId: string | null;
  timeboxExpiresAt: string;
  msRemaining: number;
  extend: string;
  flags: string[];
}

export interface OperatorDigest {
  since: string;
  generatedAt: string;
  answered: DigestAnswered[];
  pending: DigestPending[];
}

const CLASS_LINE = /^\s*Class:\s*\(?([abc])\)?\b/im;

export function classifyDecision(opened: DecisionOpenedEvent): DecisionClass {
  const explicit = opened.body ? CLASS_LINE.exec(opened.body) : null;
  if (explicit) return explicit[1]!.toLowerCase() as DecisionClass;
  return opened.timebox || opened.timeboxExpiresAt ? 'b' : 'a';
}

const CONTROL_SURFACE =
  /\b(hooks?|attestation|trusted[- ]reviewers?|signing[- ]key|merge|governance|trust[- ]chain|branch protection|review gate)\b/i;
const KNOWN_AUTHOR = /^(planner|operator)\b/i;

/**
 * Detect-and-report flags: a decision that names a governance or trust-chain
 * surface whatever its stated class, and an author that is not a recognised
 * planner or operator identity. These annotate the digest; they block nothing.
 */
export function digestFlags(o: DecisionOpenedEvent, by: string | undefined): string[] {
  const flags: string[] = [];
  const text = [o.summary, o.scope, ...o.options.map((x) => x.description)].join(' ');
  if (CONTROL_SURFACE.test(text) && classifyDecision(o) === 'a') {
    flags.push('names a governance or trust-chain surface but is class (a)');
  }
  if (by !== undefined && !KNOWN_AUTHOR.test(by)) {
    flags.push(`author "${by}" is not a recognised planner or operator identity`);
  }
  return flags;
}

function oneLine(text: string | undefined, max = 160): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

type Answer = OperatorAnsweredEvent | AutoExpiredEvent;

export function buildOperatorDigest(
  events: DecisionEvent[],
  sinceIso: string,
  now: Date = new Date(),
): OperatorDigest {
  const since = Date.parse(sinceIso);
  const opened = new Map<string, DecisionOpenedEvent>();
  const answers = new Map<string, Answer>();
  const expiry = new Map<string, string>();

  for (const ev of events) {
    if (ev.type === 'decision-opened') {
      const o = ev as DecisionOpenedEvent;
      opened.set(o.decisionId, o);
      if (o.timeboxExpiresAt) expiry.set(o.decisionId, o.timeboxExpiresAt);
    } else if (ev.type === 'timebox-extended') {
      expiry.set(ev.decisionId, (ev as { newTimeboxExpiresAt: string }).newTimeboxExpiresAt);
    } else if (ev.type === 'operator-answered' || ev.type === 'auto-expired') {
      answers.set(ev.decisionId, ev as Answer);
    }
  }

  const answered: DigestAnswered[] = [];
  for (const [id, ans] of answers) {
    const o = opened.get(id);
    if (!o || !(Date.parse(ans.ts) > since)) continue;
    const chosen = o.options.find((opt) => opt.id === ans.chosenOptionId);
    const others = o.options.filter((opt) => opt.id !== ans.chosenOptionId);
    const alt = others[0]?.id ?? '<option>';
    answered.push({
      decisionId: id,
      decisionClass: classifyDecision(o),
      summary: oneLine(o.summary),
      chosenOptionId: ans.chosenOptionId,
      chosenDescription: oneLine(chosen?.description),
      rationale: oneLine(ans.rationale),
      answeredAt: ans.ts,
      answeredBy: ans.type === 'auto-expired' ? 'auto-expired' : (ans.by ?? 'unknown'),
      flags: digestFlags(o, ans.type === 'auto-expired' ? undefined : (ans.by ?? 'unknown')),
      reverse:
        `cli-decisions answer ${id} ${alt} --rationale "<why>" ` +
        `(then undo what the chosen option applied; ${
          o.reversible === false ? 'marked hard to reverse' : 'reversible'
        })`,
    });
  }
  answered.sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));

  const pending: DigestPending[] = [];
  for (const [id, o] of opened) {
    const exp = expiry.get(id);
    if (answers.has(id) || !exp) continue;
    const ms = Date.parse(exp) - now.getTime();
    if (!(ms > 0)) continue;
    pending.push({
      decisionId: id,
      decisionClass: classifyDecision(o),
      summary: oneLine(o.summary),
      fallbackOptionId: o.autonomousFallbackOptionId ?? null,
      timeboxExpiresAt: exp,
      msRemaining: ms,
      flags: digestFlags(o, o.by),
      extend: `cli-decisions answer ${id} <option> to override now, or cli-decisions extend ${id} --timebox <duration>`,
    });
  }
  pending.sort((a, b) => a.msRemaining - b.msRemaining);

  return { since: sinceIso, generatedAt: now.toISOString(), answered, pending };
}

export function renderOperatorDigestMarkdown(d: OperatorDigest): string {
  const lines = [`# Operator digest`, ``, `Since ${d.since} (generated ${d.generatedAt})`, ``];
  lines.push(`## Decided (${d.answered.length})`, ``);
  if (d.answered.length === 0) lines.push('None.', '');
  for (const a of d.answered) {
    lines.push(
      `- **${a.decisionId}** (class ${a.decisionClass}) ${a.summary}`,
      `  - chose \`${a.chosenOptionId}\`: ${a.chosenDescription} (by ${a.answeredBy})`,
      `  - why: ${a.rationale || '(none recorded)'}`,
      `  - reverse: ${a.reverse}`,
      ...a.flags.map((f) => `  - FLAG: ${f}`),
    );
  }
  lines.push('', `## Timeboxed, still open (${d.pending.length})`, '');
  if (d.pending.length === 0) lines.push('None.', '');
  for (const p of d.pending) {
    const hours = Math.max(1, Math.round(p.msRemaining / 3_600_000));
    lines.push(
      `- **${p.decisionId}** (class ${p.decisionClass}) ${p.summary}`,
      `  - applies \`${p.fallbackOptionId ?? 'nothing (no fallback)'}\` in about ${hours}h (${p.timeboxExpiresAt})`,
      `  - override: ${p.extend}`,
      ...p.flags.map((f) => `  - FLAG: ${f}`),
    );
  }
  lines.push('');
  return lines.join('\n');
}

export interface RunOperatorDigestOpts {
  workDir: string;
  /** ISO cutoff; when absent the last --mark time, else 24h before `now`. */
  since?: string;
  /** Record `now` as the last-digest time after building the digest. */
  mark?: boolean;
  now?: Date;
}

/** Build the digest from the event log, resolving the cutoff from the marker file. */
export function runOperatorDigest(opts: RunOperatorDigestOpts): OperatorDigest {
  const now = opts.now ?? new Date();
  const dir = resolveDecisionsDir(opts.workDir);
  const markerPath = join(dir, 'last-digest.json');
  let since = opts.since ?? '';
  if (since && Number.isNaN(Date.parse(since))) {
    throw new Error(`--since "${since}" is not an ISO timestamp, for example 2026-10-01T00:00:00Z`);
  }
  if (!since && existsSync(markerPath)) {
    try {
      since = String(JSON.parse(readFileSync(markerPath, 'utf8')).at ?? '');
      // A marker in the future would hide decisions from the next digest: ignore it.
      if (Date.parse(since) > now.getTime()) since = '';
    } catch {
      since = '';
    }
  }
  if (!since || Number.isNaN(Date.parse(since))) {
    since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  }
  // Read after fixing `now`, so the marker never skips an event appended mid-run.
  const digest = buildOperatorDigest(
    readDecisionEvents({ workDir: opts.workDir }).events,
    since,
    now,
  );
  if (opts.mark) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ at: digest.generatedAt }) + '\n');
  }
  return digest;
}
