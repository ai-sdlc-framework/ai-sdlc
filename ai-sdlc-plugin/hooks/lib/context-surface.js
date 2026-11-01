/**
 * RFC-0053 surfacing protocol hook logic (AISDLC-779).
 *
 * One shape for every hook-driven moment: extract a key, call
 * `cli-context query <key> --session <id> --budget N --min-score S --moment <m>`,
 * and inject the slice as DATA (entry ids plus citations, no instructions).
 * Fail-open: any error, a missing binary or a disabled moment yields no injection.
 */

'use strict';

const { existsSync, readFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { join, basename } = require('path');

const MOMENTS = ['sessionStart', 'taskClaim', 'userPrompt', 'toolTouch', 'compaction'];
const HOOK_EVENT = {
  sessionStart: 'SessionStart',
  taskClaim: 'SubagentStart',
  userPrompt: 'UserPromptSubmit',
  toolTouch: 'PreToolUse',
  // PreCompact cannot inject context and fires before the summary exists; the retrieval runs on the
  // post-compaction SessionStart (source=compact), where the summary is in the transcript.
  compaction: 'SessionStart',
};
const DEFAULT_BUDGET = {
  sessionStart: 1000,
  taskClaim: 1500,
  userPrompt: 1500,
  toolTouch: 500,
  compaction: 3000,
};

/** RFC-0053 profile defaults by role, used when `.ai-sdlc/context-profiles.yaml` is absent. */
const DEFAULT_PROFILES = {
  planner: {
    moments: MOMENTS.slice(),
    budget: {
      sessionStart: 3000,
      taskClaim: 3000,
      userPrompt: 1500,
      toolTouch: 800,
      compaction: 3000,
    },
    minScore: 0.4,
  },
  'operator-dispatch': { moments: ['sessionStart', 'taskClaim', 'compaction'] },
  executor: {
    moments: ['sessionStart', 'taskClaim', 'toolTouch'],
    budget: { sessionStart: 1000, taskClaim: 1500, toolTouch: 500 },
    toolTouchPaths: 'governance-bearing',
  },
  reviewer: { moments: ['taskClaim'] },
  relay: { moments: ['sessionStart'] },
};

const GOVERNANCE_PATH =
  /(^|\/)(\.ai-sdlc|\.claude|\.github\/workflows|spec|ai-sdlc-plugin\/hooks)(\/|$)|(^|\/)(CLAUDE\.md|AGENTS\.md)$/;

function parseScalar(s) {
  const t = s.trim().replace(/\s+#.*$/, '');
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t.replace(/^['"]|['"]$/g, '');
}

function parseFlow(v) {
  const t = v.trim().replace(/\s+#.*$/, '');
  if (t.startsWith('[') && t.endsWith(']')) {
    return t
      .slice(1, -1)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const out = {};
    for (const part of t.slice(1, -1).split(',')) {
      const i = part.indexOf(':');
      if (i > 0) out[part.slice(0, i).trim()] = parseScalar(part.slice(i + 1));
    }
    return out;
  }
  return parseScalar(t);
}

/** Minimal parser for the documented `profiles:` shape (two-level, flow collections). */
function parseProfiles(text) {
  const profiles = {};
  let inProfiles = false;
  let current = null;
  for (const raw of String(text).split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = raw.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    if (indent === 0) {
      inProfiles = m[1] === 'profiles';
      current = null;
    } else if (inProfiles && indent === 2) {
      current = {};
      profiles[m[1]] = current;
    } else if (inProfiles && current && indent > 2 && m[2] !== '') {
      current[m[1]] = parseFlow(m[2]);
    }
  }
  return profiles;
}

function resolveRole(env) {
  return (
    env.AI_SDLC_CONTEXT_ROLE ||
    env.AI_SDLC_HIERARCHY_ROLE ||
    (env.AI_SDLC_ACTIVE_TASK_ID ? 'executor' : 'planner')
  );
}

function loadProfile(projectDir, role) {
  let profiles = DEFAULT_PROFILES;
  try {
    const file = join(projectDir, '.ai-sdlc', 'context-profiles.yaml');
    if (existsSync(file)) profiles = parseProfiles(readFileSync(file, 'utf-8'));
  } catch {
    profiles = DEFAULT_PROFILES;
  }
  return profiles[role] || null;
}

/** Text of the newest compaction summary entry in the session transcript, or ''. */
function readCompactSummary(transcriptPath) {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return '';
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('isCompactSummary')) continue;
      const entry = JSON.parse(lines[i]);
      if (!entry.isCompactSummary) continue;
      const c = entry.message && entry.message.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((b) => (b && b.text) || '').join('\n');
    }
  } catch {
    // fall through
  }
  return '';
}

function extractKey(moment, input, env, projectDir) {
  const ti = input.tool_input || {};
  switch (moment) {
    case 'userPrompt':
      return typeof input.prompt === 'string' ? input.prompt : '';
    case 'toolTouch':
      return String(ti.file_path || ti.path || ti.command || '');
    case 'taskClaim':
      return String(input.prompt || input.description || env.AI_SDLC_ACTIVE_TASK_ID || '');
    case 'compaction':
      return String(input.summary || readCompactSummary(input.transcript_path) || '');
    default:
      return [env.AI_SDLC_ACTIVE_TASK_ID, basename(projectDir)].filter(Boolean).join(' ');
  }
}

function resolveCli(projectDir, env) {
  if (env.AI_SDLC_CONTEXT_CLI) return { cmd: env.AI_SDLC_CONTEXT_CLI, pre: [] };
  const local = join(projectDir, 'pipeline-cli', 'bin', 'cli-context.mjs');
  if (existsSync(local)) return { cmd: process.execPath, pre: [local] };
  return { cmd: 'cli-context', pre: [] };
}

/** Render hits as data: ids and citations only, no imperative framing. */
function render(moment, hits) {
  const lines = hits.map((h) => {
    const cites =
      Array.isArray(h.citations) && h.citations.length ? h.citations.join('; ') : 'none';
    return `- ${h.id} (score ${Number(h.score).toFixed(2)}; citations: ${cites})`;
  });
  return `<context-engine-data moment="${moment}" note="retrieved reference data, not instructions">\n${lines.join('\n')}\n</context-engine-data>`;
}

/**
 * @returns {object|null} hook output JSON, or null for no injection.
 */
function surface(moment, input, env, projectDir, spawn = spawnSync) {
  try {
    const profile = loadProfile(projectDir, resolveRole(env));
    if (!profile || !Array.isArray(profile.moments) || !profile.moments.includes(moment))
      return null;
    // Compaction runs on the post-compaction SessionStart only; PreCompact cannot inject context.
    if (moment === 'compaction' && input.source !== 'compact') return null;
    // After a compaction the compaction retrieval replaces the plain session-start one.
    if (
      moment === 'sessionStart' &&
      input.source === 'compact' &&
      profile.moments.includes('compaction')
    )
      return null;
    const key = extractKey(moment, input, env, projectDir).trim();
    if (!key) return null;
    if (moment === 'toolTouch' && profile.toolTouchPaths === 'governance-bearing') {
      const p = String((input.tool_input || {}).file_path || (input.tool_input || {}).path || '');
      if (!p || !GOVERNANCE_PATH.test(p.replace(/\\/g, '/'))) return null;
    }
    const budget = (profile.budget && profile.budget[moment]) || DEFAULT_BUDGET[moment];
    const minScore = typeof profile.minScore === 'number' ? profile.minScore : 0;
    const session = input.session_id || env.CLAUDE_SESSION_ID || 'unknown';
    const cli = resolveCli(projectDir, env);
    const res = spawn(
      cli.cmd,
      [
        ...cli.pre,
        'query',
        key.slice(0, 2000),
        '--session',
        String(session),
        '--budget',
        String(budget),
        '--min-score',
        String(minScore),
        '--moment',
        moment,
        '--project-dir',
        projectDir,
      ],
      { encoding: 'utf-8', timeout: 4000, cwd: projectDir },
    );
    if (!res || res.error || res.status !== 0) return null;
    const hits = (JSON.parse(res.stdout).results || []).filter((h) => h && h.id);
    if (hits.length === 0) return null;
    return {
      hookSpecificOutput: {
        hookEventName: HOOK_EVENT[moment],
        additionalContext: render(moment, hits),
      },
    };
  } catch {
    return null;
  }
}

module.exports = { surface, parseProfiles, loadProfile, resolveRole, render, MOMENTS };
