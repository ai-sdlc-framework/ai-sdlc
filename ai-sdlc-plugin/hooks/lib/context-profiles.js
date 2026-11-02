/**
 * RFC-0053 context profiles (AISDLC-781, OQ-8).
 *
 * `.ai-sdlc/context-profiles.yaml` configures what the surfacing hooks inject, per role (primary
 * key) with `modelOverrides` by alias as the secondary key. A profile can only name moments,
 * budgets, a relevance floor, trunks and an injection cap. It has no way to touch the fixed
 * prefix, which carries every governance control (OQ-4): unknown keys are rejected.
 */

'use strict';

const MOMENTS = ['sessionStart', 'taskClaim', 'userPrompt', 'toolTouch', 'compaction'];
const VALID_MOMENTS = [...MOMENTS, 'decisionPoint'];
const PROFILE_KEYS = [
  'moments',
  'budget',
  'minScore',
  'trunks',
  'maxInjectionsPerNTurns',
  'toolTouchPaths',
];
const DEFAULT_BUDGET = {
  sessionStart: 1000,
  taskClaim: 1500,
  userPrompt: 1500,
  toolTouch: 500,
  compaction: 3000,
};

/** OQ-8 role table. */
const DEFAULT_PROFILES = {
  planner: {
    moments: [
      'sessionStart',
      'taskClaim',
      'userPrompt',
      'toolTouch',
      'decisionPoint',
      'compaction',
    ],
    budget: {
      sessionStart: 3000,
      taskClaim: 3000,
      userPrompt: 1500,
      toolTouch: 800,
      compaction: 3000,
    },
    minScore: 0.4,
    maxInjectionsPerNTurns: { n: 5, max: 3 },
  },
  'operator-dispatch': {
    moments: ['sessionStart', 'taskClaim', 'compaction'],
    budget: { sessionStart: 1000, taskClaim: 1500, compaction: 2000 },
    minScore: 0.5,
    maxInjectionsPerNTurns: { n: 10, max: 2 },
  },
  executor: {
    moments: ['sessionStart', 'taskClaim', 'toolTouch'],
    budget: { sessionStart: 1000, taskClaim: 1500, toolTouch: 500 },
    minScore: 0.5,
    maxInjectionsPerNTurns: { n: 10, max: 2 },
    toolTouchPaths: 'governance-bearing',
  },
  reviewer: {
    moments: ['taskClaim'],
    budget: { taskClaim: 1000 },
    minScore: 0.5,
    maxInjectionsPerNTurns: { n: 10, max: 1 },
  },
  relay: {
    moments: ['sessionStart'],
    budget: { sessionStart: 500 },
    minScore: 0.5,
    maxInjectionsPerNTurns: { n: 10, max: 1 },
  },
};

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

/** Minimal parser for the documented shape: `profiles:` and `modelOverrides:` (two-level, flow collections). */
function parseConfig(text) {
  const out = { profiles: {}, modelOverrides: {} };
  let section = null;
  let current = null;
  for (const raw of String(text).split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = raw.trim().match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    if (indent === 0) {
      section = m[1] === 'profiles' || m[1] === 'modelOverrides' ? m[1] : null;
      current = null;
    } else if (section && indent === 2) {
      current = {};
      out[section][m[1]] = current;
    } else if (section && current && indent > 2 && m[2] !== '') {
      current[m[1]] = parseFlow(m[2]);
    }
  }
  return out;
}

function validateProfile(label, p, errors, { partial }) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    errors.push(`${label}: must be a mapping`);
    return;
  }
  for (const k of Object.keys(p)) {
    if (!PROFILE_KEYS.includes(k)) errors.push(`${label}: unknown key "${k}"`);
  }
  if (p.moments !== undefined) {
    if (!Array.isArray(p.moments)) errors.push(`${label}.moments: must be a list`);
    else
      for (const m of p.moments)
        if (!VALID_MOMENTS.includes(m)) errors.push(`${label}.moments: unknown moment "${m}"`);
  } else if (!partial) {
    errors.push(`${label}.moments: required`);
  }
  if (p.budget !== undefined) {
    if (!p.budget || typeof p.budget !== 'object' || Array.isArray(p.budget))
      errors.push(`${label}.budget: must be a mapping`);
    else
      for (const [m, v] of Object.entries(p.budget)) {
        if (!VALID_MOMENTS.includes(m)) errors.push(`${label}.budget: unknown moment "${m}"`);
        else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
          errors.push(`${label}.budget.${m}: must be a non-negative number`);
      }
  }
  if (p.minScore !== undefined) {
    if (typeof p.minScore !== 'number' || !(p.minScore >= 0 && p.minScore <= 1))
      errors.push(`${label}.minScore: must be between 0 and 1`);
  }
  if (p.trunks !== undefined && !Array.isArray(p.trunks))
    errors.push(`${label}.trunks: must be a list`);
  if (p.maxInjectionsPerNTurns !== undefined) {
    const c = p.maxInjectionsPerNTurns;
    const ok =
      c &&
      typeof c === 'object' &&
      Number.isInteger(c.n) &&
      c.n > 0 &&
      Number.isInteger(c.max) &&
      c.max >= 0;
    if (!ok) errors.push(`${label}.maxInjectionsPerNTurns: needs integer n > 0 and max >= 0`);
  }
}

/**
 * @param {{profiles?: object, modelOverrides?: object}} cfg
 * @returns {string[]} error messages; empty when valid
 */
function validateConfig(cfg) {
  const errors = [];
  const c = cfg || {};
  for (const k of Object.keys(c))
    if (k !== 'profiles' && k !== 'modelOverrides') errors.push(`unknown top-level key "${k}"`);
  const profiles = c.profiles || {};
  if (Object.keys(profiles).length === 0) errors.push('profiles: at least one role is required');
  for (const [role, p] of Object.entries(profiles))
    validateProfile(`profiles.${role}`, p, errors, { partial: false });
  for (const [alias, p] of Object.entries(c.modelOverrides || {}))
    validateProfile(`modelOverrides.${alias}`, p, errors, { partial: true });
  return errors;
}

/** Role profile with the model alias entry layered over it; only fields the alias names win. */
function resolveProfile(cfg, role, model) {
  const base = (cfg.profiles || {})[role];
  if (!base) return null;
  const override = model && (cfg.modelOverrides || {})[model];
  if (!override) return base;
  const merged = { ...base, ...override };
  if (override.budget) merged.budget = { ...(base.budget || {}), ...override.budget };
  return merged;
}

function effectiveBudget(profile, moment) {
  return (profile && profile.budget && profile.budget[moment]) ?? DEFAULT_BUDGET[moment] ?? 0;
}

/** Changes that need evidence: a moment added, a budget raised, or a relevance floor lowered. */
function widenings(oldCfg, newCfg) {
  const found = [];
  for (const [role, next] of Object.entries(newCfg.profiles || {})) {
    const prev = (oldCfg.profiles || {})[role] || { moments: [] };
    for (const m of next.moments || [])
      if (!(prev.moments || []).includes(m)) found.push(`${role}: adds moment ${m}`);
    for (const m of next.moments || []) {
      if ((prev.moments || []).includes(m) && effectiveBudget(next, m) > effectiveBudget(prev, m))
        found.push(`${role}: raises ${m} budget`);
    }
    if (
      typeof prev.minScore === 'number' &&
      typeof next.minScore === 'number' &&
      next.minScore < prev.minScore
    )
      found.push(`${role}: lowers relevance floor`);
  }
  return found;
}

/**
 * Asymmetric change path (OQ-8, RFC-0050 Part B): widening needs a decision-record id,
 * narrowing is automatic.
 * @returns {{ok: boolean, widening: string[], errors: string[]}}
 */
function checkProfileChange(oldCfg, newCfg, { decisionId } = {}) {
  const errors = validateConfig(newCfg);
  const widening = widenings(oldCfg, newCfg);
  if (widening.length > 0 && !/^DEC-\d+$/.test(decisionId || ''))
    errors.push(`widening needs a decision-record id (DEC-n): ${widening.join('; ')}`);
  return { ok: errors.length === 0, widening, errors };
}

module.exports = {
  MOMENTS,
  VALID_MOMENTS,
  DEFAULT_BUDGET,
  DEFAULT_PROFILES,
  parseConfig,
  validateConfig,
  resolveProfile,
  checkProfileChange,
};
