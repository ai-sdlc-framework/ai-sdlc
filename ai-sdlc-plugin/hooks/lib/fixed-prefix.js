/**
 * Fixed-prefix renderer (RFC-0053 OQ-4, AISDLC-782).
 *
 * The fixed prefix is defined by what it may contain, not only by size:
 *   1. governance controls rendered from `spec.governance` configuration (RFC-0048),
 *   2. the role and task frame,
 *   3. pointers (path-bound rule files and runbooks).
 * Nothing else. It stays under `prefix.maxBytes` (10240); a test fails on growth.
 * Supersedes the one-time diets in AISDLC-742 and AISDLC-651.2.
 */
const { PROMPT_RULES } = require('./prompt-rules.js');
const {
  renderSessionStartHardRules,
  resolveGovernanceFromYaml,
} = require('./governance-resolver.js');

const PREFIX_MAX_BYTES = 10240;

/**
 * @param {{ governanceYaml?: string, resolved?: object, role?: string, taskId?: string, pointers?: string[], frameExtra?: string[], controlsExtra?: string[] }} input
 * @returns {{ controls: string[], frame: string[], pointers: string[] }}
 */
function buildFixedPrefix({
  governanceYaml = '',
  resolved: resolvedIn,
  role,
  taskId,
  pointers = [],
  frameExtra = [],
  controlsExtra = [],
} = {}) {
  const resolved = resolvedIn || resolveGovernanceFromYaml(governanceYaml);
  const controls = [
    ...renderSessionStartHardRules(resolved).split('\n'),
    ...PROMPT_RULES.map((r) => r.text),
    ...controlsExtra,
  ].filter((c) => c.trim());
  const frame = [];
  if (role) frame.push(`Role: ${role}`);
  if (taskId) frame.push(`Task: ${taskId}`);
  frame.push(...frameExtra);
  return { controls, frame, pointers: [...pointers] };
}

/** @param {ReturnType<typeof buildFixedPrefix>} p */
function renderFixedPrefix(p) {
  const parts = [];
  if (p.frame.length) parts.push(['## Frame', ...p.frame].join('\n'));
  parts.push(['## Governance controls', ...p.controls.map((c) => `- ${c}`)].join('\n'));
  if (p.pointers.length) parts.push(['## Pointers', ...p.pointers.map((x) => `- ${x}`)].join('\n'));
  return parts.join('\n\n') + '\n';
}

module.exports = { PREFIX_MAX_BYTES, buildFixedPrefix, renderFixedPrefix };
