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

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDecisionsConfig, resolveTimeboxConfig } from './decisions-config.js';
import { readDecisionEvents, resolveDecisionsDir } from './event-log.js';
import type {
  AutoExpiredEvent,
  DecisionEvent,
  DecisionOpenedEvent,
  OperatorAnsweredEvent,
} from './decision-record.js';

export interface Provenance {
  commit: string;
  pr: number | null;
}

/** Looks up the merge commit and PR that put a decision record on main. */
export type ProvenanceResolver = (decisionId: string) => Provenance | null;

/**
 * Default resolver: the oldest commit reachable from `ref` that added the
 * decision's id to the event log. A record that is only in an unmerged branch
 * or PR is not reachable from main, so it resolves to null.
 */
export function gitProvenanceResolver(workDir: string, ref = 'origin/main'): ProvenanceResolver {
  return (decisionId) => {
    try {
      const out = execFileSync(
        'git',
        [
          'log',
          ref,
          '--format=%H%x09%s',
          '-S',
          `"decisionId":"${decisionId}"`,
          '--',
          '.ai-sdlc/_decisions/events.jsonl',
          '.ai-sdlc/_decisions/events',
        ],
        { cwd: workDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      const oldest = out.at(-1);
      if (!oldest) return null;
      const [commit = '', subject = ''] = oldest.split('\t');
      const pr = /\(#(\d+)\)\s*$/.exec(subject);
      return { commit, pr: pr ? Number(pr[1]) : null };
    } catch {
      return null;
    }
  };
}

/** A merged change to governance config (AISDLC-720.1). */
export interface GovernanceChange {
  commit: string;
  pr: number | null;
  subject: string;
  files: string[];
  mergedAt: string;
}

/** Lists merged commits that touched governance config since an ISO cutoff. */
export type GovernanceChangeResolver = (sinceIso: string) => GovernanceChange[];

/** Governance config pathspecs: `.ai-sdlc/` config files and the workflows. Runtime artifacts excluded. */
export const GOVERNANCE_PATHSPECS = [
  '.ai-sdlc/*.yaml',
  '.ai-sdlc/*-policy.md',
  '.ai-sdlc/*-principles.md',
  '.github/workflows',
];

/** Default resolver: commits on `ref` since the cutoff that touched governance config, with their PR. */
export function gitGovernanceChangeResolver(
  workDir: string,
  ref = 'origin/main',
): GovernanceChangeResolver {
  return (sinceIso) => {
    try {
      const out = execFileSync(
        'git',
        [
          'log',
          ref,
          `--since=${sinceIso}`,
          '--format=%x01%H%x09%cI%x09%s',
          '--name-only',
          '--',
          ...GOVERNANCE_PATHSPECS,
        ],
        { cwd: workDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return out
        .split('\x01')
        .filter((c) => c.trim())
        .map((chunk) => {
          const [head = '', ...rest] = chunk.split('\n');
          const [commit = '', mergedAt = '', ...subj] = head.split('\t');
          const subject = subj.join('\t');
          const pr = /\(#(\d+)\)\s*$/.exec(subject);
          return {
            commit,
            mergedAt,
            subject,
            pr: pr ? Number(pr[1]) : null,
            files: rest.map((f) => f.trim()).filter(Boolean),
          };
        });
    } catch {
      return [];
    }
  };
}

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
  /** Where the record entered main; null when it is not on main. Undefined when not checked. */
  provenance?: Provenance | null;
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
  provenance?: Provenance | null;
}

export interface OperatorDigest {
  since: string;
  generatedAt: string;
  answered: DigestAnswered[];
  pending: DigestPending[];
  /** Every merged change to governance config in the window, with its PR (visibility only). */
  governanceChanges?: GovernanceChange[];
  /** Default class (b) timebox in hours, from config (DEC-0059). */
  defaultTimeboxHours?: number;
}

const CLASS_LINE = /^\s*Class:\s*\(?([abc])\)?\b/im;

export function classifyDecision(opened: DecisionOpenedEvent): DecisionClass {
  const explicit = opened.body ? CLASS_LINE.exec(opened.body) : null;
  if (explicit) return explicit[1]!.toLowerCase() as DecisionClass;
  return opened.timebox || opened.timeboxExpiresAt ? 'b' : 'a';
}

const CONTROL_SURFACE =
  /\b(hooks?|attestation|trusted[- ]reviewers?|signing[- ]key|merge (rights|gate|restriction)|governance|trust[- ]chain|branch protection|review gate|required checks?|rulesets?|agent-role|resolver defaults?|workflow gates?|CLAUDE\.md)\b/i;
// `--by` is free text, not authentication (DEC-0038): this only reports a name that is not planner or operator.
const KNOWN_AUTHOR = /^(planner|operator)(\s*\(|\s*,|$)/i;

/**
 * Detect-and-report flags. They annotate the digest and block nothing:
 * - an untagged decision that names a governance or trust-chain surface (a
 *   `--governance-change` tag puts it under the weakening-fallback rule instead),
 * - an author that is not a recognised planner or operator identity,
 * - a record that is not on main, which is not authority.
 */
export function digestFlags(
  o: DecisionOpenedEvent,
  by: string | undefined,
  provenance?: Provenance | null,
): string[] {
  const flags: string[] = [];
  const text = [o.summary, o.scope, ...o.options.map((x) => x.description)].join(' ');
  if (!o.governanceChange && CONTROL_SURFACE.test(text)) {
    flags.push('names a governance or trust-chain surface but carries no --governance-change tag');
  }
  if (by !== undefined && !KNOWN_AUTHOR.test(by)) {
    flags.push(`author "${by}" is not a recognised planner or operator identity`);
  }
  if (provenance === null) {
    flags.push('record is not on main, so it is not authority yet');
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
  resolveProvenance?: ProvenanceResolver,
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
    const provenance = resolveProvenance ? resolveProvenance(id) : undefined;
    const author = ans.type === 'auto-expired' ? o.by : ans.by;
    answered.push({
      decisionId: id,
      decisionClass: classifyDecision(o),
      summary: oneLine(o.summary),
      chosenOptionId: ans.chosenOptionId,
      chosenDescription: oneLine(chosen?.description),
      rationale: oneLine(ans.rationale),
      answeredAt: ans.ts,
      answeredBy: ans.type === 'auto-expired' ? 'auto-expired' : (ans.by ?? 'unknown'),
      flags: digestFlags(o, author ?? 'unknown', provenance),
      ...(provenance !== undefined ? { provenance } : {}),
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
    const pendingProvenance = resolveProvenance ? resolveProvenance(id) : undefined;
    pending.push({
      decisionId: id,
      decisionClass: classifyDecision(o),
      summary: oneLine(o.summary),
      fallbackOptionId: o.autonomousFallbackOptionId ?? null,
      timeboxExpiresAt: exp,
      msRemaining: ms,
      flags: digestFlags(o, o.by ?? 'unknown', pendingProvenance),
      ...(pendingProvenance !== undefined ? { provenance: pendingProvenance } : {}),
      extend: `cli-decisions answer ${id} <option> to override now, or cli-decisions extend ${id} --timebox <duration>`,
    });
  }
  pending.sort((a, b) => a.msRemaining - b.msRemaining);

  return { since: sinceIso, generatedAt: now.toISOString(), answered, pending };
}

function describeProvenance(p: Provenance | null, author: string | undefined): string {
  const where = p
    ? `${p.pr !== null ? `PR #${p.pr}, ` : ''}commit ${p.commit.slice(0, 8)}`
    : 'NOT on main';
  return `${where}${author ? `, claimed author ${author}` : ''} (--by is not authentication)`;
}

export function renderOperatorDigestMarkdown(d: OperatorDigest): string {
  const lines = [`# Operator digest`, ``, `Since ${d.since} (generated ${d.generatedAt})`, ``];
  if (d.defaultTimeboxHours !== undefined) {
    lines.push(
      `Default timebox: ${d.defaultTimeboxHours} hours. A weakening option never applies itself when a timebox lapses.`,
      ``,
    );
  }
  lines.push(`## Decided (${d.answered.length})`, ``);
  if (d.answered.length === 0) lines.push('None.', '');
  for (const a of d.answered) {
    lines.push(
      `- **${a.decisionId}** (class ${a.decisionClass}) ${a.summary}`,
      `  - chose \`${a.chosenOptionId}\`: ${a.chosenDescription} (by ${a.answeredBy})`,
      `  - why: ${a.rationale || '(none recorded)'}`,
      ...(a.provenance !== undefined
        ? [`  - record: ${describeProvenance(a.provenance, a.answeredBy)}`]
        : []),
      `  - reverse: ${a.reverse}`,
      ...a.flags.map((f) => `  - FLAG: ${f}`),
    );
  }
  if (d.governanceChanges !== undefined) {
    lines.push('', `## Governance config changes merged (${d.governanceChanges.length})`, '');
    if (d.governanceChanges.length === 0) lines.push('None.');
    for (const g of d.governanceChanges) {
      lines.push(
        `- ${g.pr !== null ? `PR #${g.pr}` : 'no PR'}, commit ${g.commit.slice(0, 8)}: ${g.subject}`,
        `  - files: ${g.files.join(', ')}`,
      );
    }
  }
  lines.push('', `## Timeboxed, still open (${d.pending.length})`, '');
  if (d.pending.length === 0) lines.push('None.', '');
  for (const p of d.pending) {
    const hours = Math.max(1, Math.round(p.msRemaining / 3_600_000));
    lines.push(
      `- **${p.decisionId}** (class ${p.decisionClass}) ${p.summary}`,
      `  - applies \`${p.fallbackOptionId ?? 'nothing (no fallback)'}\` in about ${hours}h (${p.timeboxExpiresAt})`,
      `  - override: ${p.extend}`,
      ...(p.provenance !== undefined
        ? [`  - record: ${describeProvenance(p.provenance, undefined)}`]
        : []),
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
  /** Where records entered main; defaults to git history of origin/main. */
  provenance?: ProvenanceResolver;
  /** Merged governance-config changes; defaults to git history of origin/main. */
  governanceChanges?: GovernanceChangeResolver;
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
    opts.provenance ?? gitProvenanceResolver(opts.workDir),
  );
  digest.defaultTimeboxHours = resolveTimeboxConfig(
    loadDecisionsConfig({ workDir: opts.workDir }),
  ).defaultHours;
  digest.governanceChanges = (opts.governanceChanges ?? gitGovernanceChangeResolver(opts.workDir))(
    since,
  );
  if (opts.mark) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ at: digest.generatedAt }) + '\n');
  }
  return digest;
}
