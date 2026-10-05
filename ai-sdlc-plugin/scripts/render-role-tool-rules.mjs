#!/usr/bin/env node
/**
 * Renders the tool rules a hierarchy role operates under, from the same resolved
 * policy the PreToolUse hook enforces, so a skill's hard-rule narration never
 * drifts from what is actually refused.
 *
 * This is intentionally a thin print wrapper: the ONLY source of truth for the
 * rule TEXT and for the rules themselves is
 * `ai-sdlc-plugin/hooks/lib/role-tool-policy.js`. No rule text is duplicated here.
 *
 * Usage (from a slash-command body, via Bash):
 *   node "$PLUGIN_SCRIPTS_DIR/render-role-tool-rules.mjs" --role executor
 *
 * With no `governance.roles` section in `.ai-sdlc/agent-role.yaml` (the common
 * case) the output is the strict default for the role. A repo that relaxes the
 * list through `governance.roles.<role>.blockedTools` gets the matching text.
 * The policy is read from the project root (`CLAUDE_PROJECT_DIR` or
 * `git rev-parse --show-toplevel`), preferring the main checkout's copy, exactly
 * as the hook does.
 *
 * Exit codes: 0 on success, 2 when `--role` is missing or not a hierarchy role.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const { ROLES, loadRoleBlockedTools, renderRoleToolRules } = require(
  join(__dirname, '..', 'hooks', 'lib', 'role-tool-policy.js'),
);

function resolveProjectDir() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--role');
  const role = at === -1 ? undefined : args[at + 1];
  if (!role || !ROLES.includes(role)) {
    process.stderr.write(`render-role-tool-rules: --role must be one of ${ROLES.join(', ')}\n`);
    process.exit(2);
  }
  const rules = loadRoleBlockedTools(resolveProjectDir());
  process.stdout.write(renderRoleToolRules(role, rules[role]) + '\n');
}

main();
