#!/usr/bin/env node
/**
 * Renders the resolved governance hard-rules bullets (merge / force-push /
 * close-PR-or-issue / branch-delete / reset-hard) for the current project,
 * so command bodies (`execute.md`, `execute-parallel.md`) never drift from
 * the same resolved policy the SessionStart / SubagentStart hooks already
 * inject (RFC-0048 / AISDLC-601, AISDLC-602).
 *
 * This is intentionally a thin print wrapper — the ONLY source of truth for
 * the rule TEXT is `ai-sdlc-plugin/hooks/lib/governance-resolver.js`'s
 * `renderSubagentHardRules()`, the exact function the SubagentStart banner
 * already uses. No rule text is duplicated here.
 *
 * Usage (from a slash-command body, via Bash):
 *   node "${CLAUDE_PLUGIN_ROOT:-$(pwd)/ai-sdlc-plugin}/scripts/render-governance-hard-rules.mjs"
 *
 * With no `governance:` section in `.ai-sdlc/agent-role.yaml` (the common
 * case), every rule renders its strict text except force-push, which renders the
 * `allowForcePush: leaseOnOwnBranch` default (AISDLC-710).
 *
 * Trust boundary (mirrors governance-resolver.js): resolves the policy from
 * the on-disk project root (`CLAUDE_PROJECT_DIR` or `git rev-parse
 * --show-toplevel`), which is always the trusted base-branch checkout for
 * the session/command-body flows this script is invoked from — never PR
 * diff content.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const resolverPath = join(__dirname, '..', 'hooks', 'lib', 'governance-resolver.js');
const { resolveGovernanceFromYaml, renderSubagentHardRules } = require(resolverPath);

function resolveProjectDir() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

function main() {
  const projectDir = resolveProjectDir();
  const agentRolePath = join(projectDir, '.ai-sdlc', 'agent-role.yaml');

  let yaml = '';
  if (existsSync(agentRolePath)) {
    try {
      yaml = readFileSync(agentRolePath, 'utf-8');
    } catch {
      // Unreadable policy: fail closed. An empty string would resolve to the
      // `leaseOnOwnBranch` default (AISDLC-710), so spell the strict force-push value.
      yaml = 'spec:\n  governance:\n    allowForcePush: never\n';
    }
  }

  const resolved = resolveGovernanceFromYaml(yaml);
  process.stdout.write(renderSubagentHardRules(resolved) + '\n');
}

main();
