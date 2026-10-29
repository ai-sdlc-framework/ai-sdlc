/**
 * AISDLC-1113: a decisions CLI test that escalates with --route or --park must
 * inject a chain; the system chain would reach live hierarchy sessions.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSystemChainDeps, testSentMessages } from '../decisions/escalation-chain.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Argument text of every `buildDecisionsCli(...)` call in `source`. */
function cliCallArgs(source: string): string[] {
  const out: string[] = [];
  const re = /buildDecisionsCli\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

describe('decisions CLI tests never reach the system chain (AISDLC-1113)', () => {
  const files = readdirSync(here).filter(
    (f) => /^decisions.*\.test\.ts$/.test(f) && f !== 'decisions-no-live-chain.test.ts',
  );

  it('finds the decisions test files', () => {
    expect(files).toContain('decisions.test.ts');
    expect(files).toContain('decisions-escalation.test.ts');
  });

  it.each(files)('%s injects a chain wherever it escalates with --route or --park', (file) => {
    const source = readFileSync(join(here, file), 'utf8');
    // A test block that runs `escalate` with --route or --park, or the shared
    // helper that does, must build its CLI with an injected chain.
    const blocks = source.split(/\n\s*it(?:\.each\([^)]*\))?\(/);
    for (const block of blocks) {
      const escalates = /escalate/.test(block) && /['"]--(route|park)['"]/.test(block);
      if (!escalates) continue;
      for (const args of cliCallArgs(block)) {
        expect(args, `${file}: buildDecisionsCli() without a chain`).toMatch(/\bchain\b\s*[:,}]/);
      }
    }
  });

  it('createSystemChainDeps sends nothing to tmux under Vitest', () => {
    testSentMessages.length = 0;
    const deps = createSystemChainDeps('/nonexistent-aisdlc-1113');
    deps.send(
      {
        role: 'planner',
        name: 'planner',
        tmuxSession: 'x',
        tmuxWindow: 'x',
        paneId: '%0',
        pid: 1,
        model: 'm',
        permissionMode: 'p',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'running',
      },
      'hello',
    );
    expect(testSentMessages).toEqual([{ to: 'planner', message: 'hello' }]);
  });
});
