/**
 * AISDLC-245.4 — Repo-wide regression: no slash command body invokes a
 * hardcoded `node pipeline-cli/bin/...` or `node ai-sdlc-plugin/scripts/...`
 * path. Every body MUST resolve via $PIPELINE_CLI_BIN / $PLUGIN_SCRIPTS_DIR
 * (set by the path-resolution preamble using $CLAUDE_PLUGIN_DIR with a
 * dogfood-monorepo fallback).
 *
 * Why this exists: per the AISDLC-245.4 code-reviewer MAJOR finding, the
 * per-body regression tests in execute.test.mjs and orchestrator-tick.test.mjs
 * only catch the body they're paired with. A future dev adding a NEW slash
 * command could re-introduce bare paths in fix-pr.md, status.md, etc. This
 * cross-body scan blocks that drift.
 *
 * Allowed (these are NOT executable invocations, they're prose):
 *   - Lines starting with `>` (markdown blockquote — historical narration)
 *   - Lines containing literal `node ai-sdlc-plugin/scripts/sign-attestation.mjs`
 *     within sentences explaining AISDLC-133 retiring the inline signer
 *   - Lines that quote the path inside backticks (markdown code spans)
 *
 * Rejected (executable invocations):
 *   - `node pipeline-cli/bin/X.mjs ...` at the start of a bash code line
 *   - `node ai-sdlc-plugin/scripts/X.mjs ...` ditto
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS_DIR = dirname(fileURLToPath(import.meta.url));

/** Pattern: `node pipeline-cli/bin/...` or `node ai-sdlc-plugin/scripts/...`
 * appearing as the FIRST non-whitespace token on a line (i.e. an executable
 * shell invocation, not a prose mention). */
const BARE_PATH_RE = /^\s*node\s+(?:pipeline-cli\/bin|ai-sdlc-plugin\/scripts)\//;

describe('AISDLC-245.4 — no bare hardcoded paths in slash command bodies', () => {
  it('every commands/*.md uses $PIPELINE_CLI_BIN / $PLUGIN_SCRIPTS_DIR', () => {
    const offenders = [];
    const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));

    for (const file of files) {
      const content = readFileSync(join(COMMANDS_DIR, file), 'utf8');
      content.split('\n').forEach((line, idx) => {
        // Skip markdown blockquotes (prose narration)
        if (/^\s*>/.test(line)) return;
        // Skip lines where the bare path is INSIDE a backtick code span
        // (markdown inline code, not an executable invocation)
        if (/`[^`]*node\s+(?:pipeline-cli\/bin|ai-sdlc-plugin\/scripts)/.test(line)) return;
        if (BARE_PATH_RE.test(line)) {
          offenders.push({ file, line: idx + 1, snippet: line.trim().slice(0, 100) });
        }
      });
    }

    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`).join('\n');
      throw new Error(
        `AISDLC-245.4: ${offenders.length} bare hardcoded path(s) found in slash command bodies. ` +
          `Use $PIPELINE_CLI_BIN / $PLUGIN_SCRIPTS_DIR resolved via $CLAUDE_PLUGIN_DIR instead. ` +
          `See ai-sdlc-plugin/README.md for the convention.\n${detail}`,
      );
    }
    assert.equal(offenders.length, 0);
  });
});
