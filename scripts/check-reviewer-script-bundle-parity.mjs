#!/usr/bin/env node
/**
 * Reviewer script bundle-parity gate (AISDLC-626).
 *
 * Root cause: AISDLC-562/#970 added `scripts/resolve-transcript-task-id.sh`
 * and made every Bash-capable reviewer agent `.md` resolve it via the
 * `${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh` / `${CLAUDE_PLUGIN_DIR}/scripts/<name>.sh`
 * candidate-list idiom (so it works across plugin-install topologies) — but
 * the script was never copied into `ai-sdlc-plugin/scripts/`, the directory
 * that actually ships to adopters. Adopter reviewer runs hit `exit 127`
 * (script not found) and hard-refused. AISDLC-623 fixed that ONE script and
 * added a hand-written byte-parity test for it, but nothing asserted the
 * GENERAL property: "every plugin-root-resolved script an agent `.md`
 * references actually exists in the bundle". This gate is that generalized,
 * self-updating assertion.
 *
 * Scope (deliberately narrow): this gate only cares about scripts resolved
 * through the `${CLAUDE_PLUGIN_ROOT}/scripts/...}` or
 * `${CLAUDE_PLUGIN_DIR}/scripts/...}` candidate-list idiom in
 * `ai-sdlc-plugin/agents/*.md` — that pattern is the one that crosses the
 * plugin-install boundary and therefore MUST live in the bundle. Plain
 * `scripts/<name>.sh` references with no plugin-root candidate (e.g.
 * `developer.md`'s `scripts/check-backlog-drift-on-push.sh`, or
 * `rebase-resolver.md`'s `scripts/check-skip-ci-marker.sh`) are dogfood
 * monorepo-only references — they run inside THIS repo's worktree, not an
 * adopter install, and are out of scope by design.
 *
 * For every referenced script name this gate:
 *   1. Asserts a copy exists at `ai-sdlc-plugin/scripts/<name>` (the bundle).
 *   2. If a copy of the SAME name also exists at `scripts/<name>` (the
 *      manual hand-dup pattern, e.g. `resolve-transcript-task-id.sh`),
 *      asserts the two copies are byte-identical — mirroring the existing
 *      `check-attestation-sign.sh` parity idiom.
 *
 * This is a ratchet that generalizes: adding a new reviewer script or a new
 * `.md` reference is covered automatically by the scan — no per-script
 * hand-wiring required.
 *
 * Usage:
 *   node scripts/check-reviewer-script-bundle-parity.mjs [--repo-root <dir>]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname_ = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname_, '..');

/**
 * Matches `${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh` and
 * `${CLAUDE_PLUGIN_DIR}/scripts/<name>.sh` (with or without a `:-...}`
 * bash-default-value suffix inside the braces, e.g.
 * `${CLAUDE_PLUGIN_ROOT:-}/scripts/foo.sh`).
 */
const PLUGIN_ROOT_SCRIPT_REF =
  /\$\{CLAUDE_PLUGIN_(?:ROOT|DIR)(?::-[^}]*)?\}\/scripts\/([A-Za-z0-9_-]+\.sh)/g;

/** List every `*.md` file directly under `ai-sdlc-plugin/agents/`. */
export function listAgentMarkdownFiles(repoRoot) {
  const dir = join(repoRoot, 'ai-sdlc-plugin', 'agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

/**
 * Scan a single agent `.md` file's source for plugin-root-resolved script
 * references. Returns a Set of bare script filenames (e.g.
 * `resolve-transcript-task-id.sh`).
 */
export function extractPluginRootScriptRefs(markdownSource) {
  const names = new Set();
  for (const match of markdownSource.matchAll(PLUGIN_ROOT_SCRIPT_REF)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Scan every agent `.md` under `ai-sdlc-plugin/agents/` and return a Map of
 * script filename -> Set of referencing `.md` file paths (repo-relative).
 */
export function scanReviewerScriptReferences(repoRoot) {
  const references = new Map();
  for (const mdPath of listAgentMarkdownFiles(repoRoot)) {
    const source = readFileSync(mdPath, 'utf-8');
    const names = extractPluginRootScriptRefs(source);
    if (names.size === 0) continue;
    const rel = mdPath.slice(repoRoot.length + 1);
    for (const name of names) {
      if (!references.has(name)) references.set(name, new Set());
      references.get(name).add(rel);
    }
  }
  return references;
}

/**
 * Run the full gate against `repoRoot`. Returns `{ ok, problems }` where
 * `problems` is an array of human-readable strings (empty when `ok`).
 * Pure function — no process.exit, no console output — so tests can assert
 * on the structured result.
 */
export function checkReviewerScriptBundleParity(repoRoot) {
  const problems = [];
  const references = scanReviewerScriptReferences(repoRoot);

  for (const [scriptName, referencingFiles] of references) {
    const bundlePath = join(repoRoot, 'ai-sdlc-plugin', 'scripts', scriptName);
    const referencedBy = [...referencingFiles].sort().join(', ');

    if (!existsSync(bundlePath)) {
      problems.push(
        `missing bundled copy: "${scriptName}" is resolved via ` +
          '${CLAUDE_PLUGIN_ROOT}/scripts/... (or CLAUDE_PLUGIN_DIR) in ' +
          `${referencedBy} but does not exist at ai-sdlc-plugin/scripts/${scriptName}. ` +
          'Adopter installs will hit "exit 127: script not found" (AISDLC-562/#970 root cause).',
      );
      continue;
    }

    const rootPath = join(repoRoot, 'scripts', basename(scriptName));
    if (existsSync(rootPath)) {
      const rootContent = readFileSync(rootPath, 'utf-8');
      const bundleContent = readFileSync(bundlePath, 'utf-8');
      if (rootContent !== bundleContent) {
        problems.push(
          `parity drift: "scripts/${scriptName}" and "ai-sdlc-plugin/scripts/${scriptName}" ` +
            `are both present (referenced by ${referencedBy}) but are NOT byte-identical. ` +
            'The dogfood monorepo copy and the adopter-facing bundled copy have diverged.',
        );
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--repo-root');
  const repoRoot = rootIdx !== -1 && args[rootIdx + 1] ? args[rootIdx + 1] : DEFAULT_REPO_ROOT;

  const { ok, problems } = checkReviewerScriptBundleParity(repoRoot);
  if (!ok) {
    console.error('[check-reviewer-script-bundle-parity] FAILED:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log('[check-reviewer-script-bundle-parity] OK: reviewer script bundle parity holds.');
}

// Only run main() when this module is invoked directly (node script.mjs),
// not when imported by the test suite.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
