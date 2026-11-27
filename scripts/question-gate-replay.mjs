#!/usr/bin/env node
/**
 * Offline replay of the operator-question gate (AISDLC-1443, AC 8).
 *
 * Runs `runQuestionGate` from ai-sdlc-plugin/hooks/lib/question-gate.js over
 * every `AskUserQuestion` call in the local Claude Code session transcripts of
 * the last N days and reports how many each check would deny. Check 4 is run
 * in `deny` mode so its would-deny set can be hand-labelled before it goes
 * live. Checks 2 and 3 run only with `--judge` (they call the judgment
 * provider through `cli-judgment question-gate`); without it they abstain.
 *
 * The session role is taken from the transcript's `agent-name` entries
 * (`ai-sdlc-executor-*`, `ai-sdlc-operator-dispatch`, `ai-sdlc-planner`), the
 * names `cli-hierarchy up` gives its sessions.
 *
 * Usage:
 *   node scripts/question-gate-replay.mjs [--days 30] [--dir <transcripts dir>]
 *        [--denied-out <file.jsonl>] [--judge]
 *
 * `--dir` defaults to ~/.claude/projects/<this checkout's path with / as ->.
 * `--denied-out` writes the check-4 would-deny set (question, header, options)
 * for hand labelling. Nothing is written into the repository.
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gate = require(join(ROOT, 'ai-sdlc-plugin/hooks/lib/question-gate.js'));

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hierarchy role from a `cli-hierarchy up` session name, or null. */
export function roleFromAgentName(name) {
  if (typeof name !== 'string') return null;
  if (name.startsWith('ai-sdlc-executor')) return 'executor';
  if (name.startsWith('ai-sdlc-operator-dispatch')) return 'operator-dispatch';
  if (name.startsWith('ai-sdlc-planner')) return 'planner';
  return null;
}

/**
 * Every main-thread AskUserQuestion call in one transcript, with the role in
 * force and the current turn up to (not including) the call.
 * @param {object[]} entries parsed transcript lines, oldest first.
 * @param {number} sinceMs calls before this time are skipped.
 */
export function askCalls(entries, sinceMs = 0) {
  const calls = [];
  let role = null;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e) continue;
    if (e.type === 'agent-name') role = roleFromAgentName(e.agentName);
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const b of content) {
      if (!b || b.type !== 'tool_use' || b.name !== 'AskUserQuestion') continue;
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t) && t < sinceMs) continue;
      calls.push({
        id: b.id,
        sessionId: e.sessionId,
        timestamp: e.timestamp,
        role,
        toolInput: b.input || {},
        turn: gate.currentTurn(entries.slice(0, i)),
      });
    }
  }
  return calls;
}

/**
 * Replay calls through the gate and tally the outcomes.
 * @param {object[]} calls from {@link askCalls}; deduplicated by tool-use id.
 * @param {{ judge?: Function }} [opts]
 */
export function replay(calls, opts = {}) {
  const seen = new Set();
  const summary = {
    total: 0,
    wouldDeny: { unattended: 0, 'already-decided': 0, 'own-class': 0, rubric: 0 },
    openQuestionExempt: 0,
    reachedRubric: 0,
    rubricAllowedBy: { 'decision-rubric': 0, trivial: 0 },
  };
  const rubricDenied = [];
  for (const c of calls) {
    if (c.id && seen.has(c.id)) continue;
    if (c.id) seen.add(c.id);
    summary.total += 1;
    const res = gate.runQuestionGate({
      input: { tool_input: c.toolInput, session_id: c.sessionId },
      role: c.role,
      judge: opts.judge,
      turn: c.turn,
      env: {},
      rubricMode: 'deny',
    });
    for (const r of res.records) {
      if (r.outcome === 'deny' || r.outcome === 'shadow-would-deny')
        summary.wouldDeny[r.check] += 1;
      if (r.check === 'open-question') summary.openQuestionExempt += 1;
      if (r.check === 'rubric') {
        summary.reachedRubric += 1;
        if (r.outcome === 'allow') summary.rubricAllowedBy[r.basis] += 1;
        if (r.outcome === 'deny') {
          rubricDenied.push({
            id: c.id,
            timestamp: c.timestamp,
            role: c.role,
            questions: (c.toolInput.questions || []).map((q) => ({
              question: q.question,
              header: q.header,
              options: (q.options || []).map((o) => ({
                label: o.label,
                description: o.description,
              })),
            })),
          });
        }
      }
    }
  }
  return { summary, rubricDenied };
}

/** Parse a JSONL transcript, skipping unparsable lines. */
export function readTranscript(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return out;
}

/** The Claude Code transcripts directory for a checkout path. */
export function defaultTranscriptDir(root = ROOT, home = homedir()) {
  return join(home, '.claude', 'projects', root.replace(/[/.]/g, '-'));
}

function parseArgs(argv) {
  const args = { days: 30, dir: undefined, deniedOut: undefined, judge: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--denied-out') args.deniedOut = argv[++i];
    else if (a === '--judge') args.judge = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.days) || args.days <= 0) throw new Error('--days must be positive');
  return args;
}

export async function main(argv = process.argv.slice(2), now = Date.now()) {
  const args = parseArgs(argv);
  const dir = args.dir ?? defaultTranscriptDir();
  if (!existsSync(dir)) throw new Error(`no transcripts directory: ${dir}`);
  const sinceMs = now - args.days * DAY_MS;
  let judge;
  if (args.judge) {
    const { makeJudge } = require(join(ROOT, 'ai-sdlc-plugin/hooks/question-gate.js'));
    judge = makeJudge(ROOT);
  }
  const calls = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    if (statSync(file).mtimeMs < sinceMs) continue;
    if (!readFileSync(file, 'utf-8').includes('"name":"AskUserQuestion","input"')) continue;
    calls.push(...askCalls(readTranscript(file), sinceMs));
  }
  const { summary, rubricDenied } = replay(calls, { judge });
  if (args.deniedOut) {
    writeFileSync(args.deniedOut, rubricDenied.map((d) => JSON.stringify(d)).join('\n') + '\n');
  }
  process.stdout.write(`${JSON.stringify({ days: args.days, dir, ...summary }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`question-gate-replay: ${err.message}\n`);
      process.exit(1);
    },
  );
}
