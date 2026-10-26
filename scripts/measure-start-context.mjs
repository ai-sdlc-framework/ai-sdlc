#!/usr/bin/env node
/**
 * Measure the executor session start context (AISDLC-1067).
 *
 * Method. Two modes:
 *
 *  1. Static (default, deterministic, used by the CI budget test): estimates tokens per
 *     contributor that this repository controls, at 4 characters per token:
 *       - command body       ai-sdlc-plugin/commands/executor.md without front matter
 *       - CLAUDE.md          the project instructions
 *       - governance block   stdout of the SessionStart hook (session-start.js), counted for
 *                            every registration of that hook across .claude/settings.json and
 *                            the plugin manifest, because each registration prints one block
 *       - governance skill   ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md (autoContext)
 *     Skill and agent listings and MCP tool schemas depend on the operator's machine and are
 *     not in the static figure; they show up only in the transcript mode.
 *
 *  2. Transcript (`--transcript <file.jsonl>`): reads the first two assistant `usage` blocks of
 *     a fresh executor Claude Code transcript and prints the real input + cache tokens of the
 *     second model call; the remainder is that total minus the static contributors.
 *
 * Usage: node scripts/measure-start-context.mjs [--json] [--transcript <file>]
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CHARS_PER_TOKEN = 4;

export const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Number of registrations of the session-start hook across the settings layers. */
export function countSessionStartRegistrations(root = ROOT) {
  let n = 0;
  for (const rel of ['.claude/settings.json', 'ai-sdlc-plugin/.claude-plugin/plugin.json']) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    for (const group of cfg.hooks?.SessionStart ?? []) {
      for (const h of group.hooks ?? []) if (/session-start\.sh/.test(h.command ?? '')) n += 1;
    }
  }
  return n;
}

function governanceBlock() {
  const r = spawnSync('node', [join(ROOT, 'ai-sdlc-plugin/hooks/session-start.js')], {
    input: JSON.stringify({ session_id: 'measure-start-context', source: 'startup' }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, CLAUDE_PLUGIN_ROOT: '' },
    encoding: 'utf8',
  });
  try {
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  } catch {
    return '';
  }
}

export function measureStatic() {
  const command = read('ai-sdlc-plugin/commands/executor.md').replace(/^---\n[\s\S]*?\n---\n/, '');
  const governance = governanceBlock();
  const registrations = Math.max(1, countSessionStartRegistrations());
  const contributors = {
    'command body': estimateTokens(command),
    'CLAUDE.md': estimateTokens(read('CLAUDE.md')),
    'governance block': estimateTokens(governance) * registrations,
    'governance skill': estimateTokens(read('ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md')),
  };
  const total = Object.values(contributors).reduce((a, b) => a + b, 0);
  return { contributors, total, registrations };
}

export function measureTranscript(file) {
  const calls = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((e) => e.message?.usage ?? e.usage)
    .filter(Boolean);
  const u = calls[1] ?? calls[0];
  if (!u) throw new Error('no assistant usage found in transcript');
  return (
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const m = measureStatic();
  const ti = args.indexOf('--transcript');
  const second = ti >= 0 ? measureTranscript(args[ti + 1]) : null;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...m, secondCallTokens: second }));
  } else {
    for (const [k, v] of Object.entries(m.contributors)) console.log(`${k.padEnd(18)} ${v}`);
    console.log(`${'static total'.padEnd(18)} ${m.total}`);
    console.log(`SessionStart registrations: ${m.registrations}`);
    if (second !== null) {
      console.log(`second call total  ${second}`);
      console.log(`remainder          ${second - m.total}`);
    }
  }
}
