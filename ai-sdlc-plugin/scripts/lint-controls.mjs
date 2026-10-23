#!/usr/bin/env node
/**
 * Control-sentence lint (AISDLC-782): refuses a control-shaped sentence outside the
 * fixed prefix that is not rendered from configuration. Scans `.claude/rules/*.md`
 * files without `paths:` frontmatter and knowledge entries.
 *
 * Usage: node ai-sdlc-plugin/scripts/lint-controls.mjs [--root <dir>]
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { lintControls } = require('../hooks/lib/control-linter.js');
const { buildFixedPrefix, renderFixedPrefix } = require('../hooks/lib/fixed-prefix.js');

export function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.name.endsWith('.md'))
        out.push({ path: relative(root, full), text: readFileSync(full, 'utf-8') });
    }
  };
  walk(join(root, '.claude/rules'));
  walk(join(root, '.ai-sdlc/knowledge'));
  return out;
}

export function runLint(root) {
  const roleYaml = join(root, '.ai-sdlc/agent-role.yaml');
  const governanceYaml = existsSync(roleYaml) ? readFileSync(roleYaml, 'utf-8') : '';
  const prefixText = renderFixedPrefix(buildFixedPrefix({ governanceYaml }));
  return lintControls({ files: collectFiles(root), prefixText });
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const i = process.argv.indexOf('--root');
  const root = resolve(i > 0 ? process.argv[i + 1] : '.');
  const findings = runLint(root);
  for (const f of findings)
    console.error(`${f.path}: control sentence outside the fixed prefix: ${f.sentence}`);
  process.exit(findings.length ? 1 : 0);
}
