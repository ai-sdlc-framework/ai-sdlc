#!/usr/bin/env node
/**
 * Regenerates the `<!-- prompt-rules:begin ... -->` blocks in every plugin agent and
 * command prompt from the single source `hooks/lib/prompt-rules.js` (AISDLC-651.2).
 *
 * Usage:
 *   node ai-sdlc-plugin/scripts/sync-prompt-rules.mjs          # rewrite drifted blocks
 *   node ai-sdlc-plugin/scripts/sync-prompt-rules.mjs --check  # exit 1 if any block drifted
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const { syncPromptRules, findPromptRulesBlock } = require(
  join(pluginDir, 'hooks', 'lib', 'prompt-rules.js'),
);

const check = process.argv.includes('--check');
let drifted = 0;

for (const dir of ['agents', 'commands']) {
  for (const f of readdirSync(join(pluginDir, dir)).filter((n) => n.endsWith('.md'))) {
    const path = join(pluginDir, dir, f);
    const before = readFileSync(path, 'utf-8');
    if (!findPromptRulesBlock(before)) continue;
    const after = syncPromptRules(before);
    if (after === before) continue;
    drifted += 1;
    if (check) {
      console.error(`drifted: ${dir}/${f}`);
    } else {
      writeFileSync(path, after);
      console.log(`updated: ${dir}/${f}`);
    }
  }
}

process.exit(check && drifted > 0 ? 1 : 0);
