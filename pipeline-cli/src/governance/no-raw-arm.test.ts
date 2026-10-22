/**
 * AISDLC-975: arming or merging goes only through the merge-if-eligible module.
 * No other non-test source may build a gh invocation whose `pr` subcommand is
 * the merge verb.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const ALLOWED = new Set(['pipeline-cli/src/governance/merge-if-eligible.ts']);
// Excluded: the adopter workflow template is YAML text for a GitHub Actions job
// (shell text in the adopter's CI with its own PAT, not a gh call built by our
// process), so only the argv form below is matched and the template never is.
const EXCLUDED = new Set<string>();
const RAW_MERGE = /'pr'\s*,\s*'merge'|"pr"\s*,\s*"merge"/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(p, out);
    } else if (
      p.endsWith('.ts') &&
      !p.endsWith('.d.ts') &&
      !/\.test\.ts$/.test(p) &&
      !p.includes('__test-helpers')
    ) {
      out.push(p);
    }
  }
  return out;
}

describe('no raw gh pr merge outside merge-if-eligible', () => {
  it('finds no gh invocation with the merge verb in non-test source', () => {
    const offenders: string[] = [];
    for (const root of ['pipeline-cli/src', 'orchestrator/src']) {
      for (const file of walk(join(repoRoot, root))) {
        const rel = relative(repoRoot, file);
        if (ALLOWED.has(rel) || EXCLUDED.has(rel)) continue;
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*')) return;
          if (RAW_MERGE.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
