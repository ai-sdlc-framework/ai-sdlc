import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContextCli } from '../cli/context.js';
import { hashValue } from './entry.js';
import { loadKnowledgeConfig } from './config.js';
import { auditLines, readKnowledgeLog } from './log.js';
import { DEFAULT_ONTOLOGY } from './ontology.js';
import {
  promoteEntry,
  refuteEntry,
  reobserveEntry,
  verifyProof,
  type VerifyContext,
} from './promote.js';

let root: string;
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

const TRACKED = '.ai-sdlc/knowledge';
const entryPath = '.ai-sdlc/knowledge/systems/k-1.md';

function entry(over: Record<string, unknown> = {}): string {
  const value = 'The gateway retries 3 times';
  const f = {
    id: 'k-1',
    trunk: 'systems',
    type: 'fact',
    value,
    confidence: 0.5,
    authority: 'inferred',
    scope: 'internal',
    source: 'src/gateway.ts',
    observed: '2026-10-09',
    decay: 'durable',
    relations: [],
    contentHash: hashValue(value),
    ...over,
  };
  return `---\n${JSON.stringify(f)}\n---\nnotes\n`;
}

function repo(extra: Record<string, string> = {}, entryOver: Record<string, unknown> = {}): string {
  root = mkdtempSync(join(tmpdir(), 'promote-'));
  const files: Record<string, string> = {
    [entryPath]: entry(entryOver),
    'src/a.test.ts': 'x',
    '.ai-sdlc/_decisions/events/2026-10-10T00-00-00.000Z__DEC-0091__decision-opened__abc.json':
      '{}',
    ...extra,
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return root;
}

const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({
  projectDir: root,
  ontology: DEFAULT_ONTOLOGY,
  config: loadKnowledgeConfig(root),
  ...over,
});
const tracked = () => join(root, TRACKED);
const authority = () =>
  /"?authority"?:\s*"?(\w+)/.exec(readFileSync(join(root, entryPath), 'utf-8'))?.[1];

describe('promotion verifier', () => {
  it('refuses a proof kind outside the vocabulary and keeps the entry inferred', () => {
    repo();
    const r = promoteEntry(
      tracked(),
      'k-1',
      { to: 'specialist', proof: 'shell:rm -rf /', by: 'agent' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('closed vocabulary');
    expect(authority()).toBe('inferred');
  });

  it('does not promote on a forged or failing test id', () => {
    repo();
    expect(verifyProof('test-id:src/nope.test.ts', ctx()).ok).toBe(false);
    expect(verifyProof('test-id:../x.test.ts', ctx()).ok).toBe(false);
    expect(verifyProof('test-id:src/a.test.ts', ctx({ runTest: () => false })).ok).toBe(false);
    expect(verifyProof('test-id:src/a.test.ts::t', ctx({ runTest: () => true })).ok).toBe(true);
  });

  it('refuses a test file that differs from the committed tree', () => {
    repo();
    writeFileSync(join(root, 'src/a.test.ts'), 'changed');
    expect(verifyProof('test-id:src/a.test.ts', ctx({ runTest: () => true })).ok).toBe(false);
  });

  it('promotes a decision id only when present on main', () => {
    repo();
    expect(verifyProof('decision-id:DEC-0091', ctx()).ok).toBe(true);
    expect(verifyProof('decision-id:DEC-0999', ctx()).ok).toBe(false);
    expect(verifyProof('decision-id:nope', ctx()).ok).toBe(false);
  });

  it('promotes a path only when tracked', () => {
    repo();
    writeFileSync(join(root, 'untracked.txt'), 'x');
    expect(verifyProof('path-exists:src/a.test.ts', ctx()).ok).toBe(true);
    expect(verifyProof('path-exists:untracked.txt', ctx()).ok).toBe(false);
    expect(verifyProof('path-exists:/etc/passwd', ctx()).ok).toBe(false);
  });

  it('promotes a command proof only for an allowlisted command whose output matches', () => {
    repo();
    const config = { ...ctx().config, allowlistedCommands: { ver: ['tool', '--version'] } };
    const runCommand = () => 'tool 1.2.3\n';
    expect(verifyProof('allowlisted-command:ver::1.2', ctx({ config, runCommand })).ok).toBe(true);
    expect(verifyProof('allowlisted-command:ver::9.9', ctx({ config, runCommand })).ok).toBe(false);
    expect(verifyProof('allowlisted-command:rm::x', ctx({ config, runCommand })).ok).toBe(false);
    expect(verifyProof('allowlisted-command:ver', ctx({ config, runCommand })).ok).toBe(false);
    expect(
      verifyProof(
        'allowlisted-command:ver::1',
        ctx({
          config,
          runCommand: () => {
            throw new Error('x');
          },
        }),
      ).ok,
    ).toBe(false);
  });

  it('refuses canonical for an agent and allows a human', () => {
    repo();
    expect(promoteEntry(tracked(), 'k-1', { to: 'canonical', by: 'agent' }, ctx()).ok).toBe(false);
    expect(authority()).toBe('inferred');
    expect(promoteEntry(tracked(), 'k-1', { to: 'canonical', by: 'human' }, ctx()).ok).toBe(true);
    expect(authority()).toBe('canonical');
  });

  it('requires a proof for specialist and reports a missing entry', () => {
    repo();
    expect(promoteEntry(tracked(), 'k-1', { to: 'specialist', by: 'agent' }, ctx()).ok).toBe(false);
    expect(promoteEntry(tracked(), 'zzz', { to: 'specialist', by: 'agent' }, ctx()).ok).toBe(false);
  });

  it('logs promotion, supersession-style refutation, and audit lists the proof', () => {
    repo({}, { writtenBy: 'agent', reverify: 'check' });
    const r = promoteEntry(
      tracked(),
      'k-1',
      { to: 'specialist', proof: 'decision-id:DEC-0091', by: 'agent' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(authority()).toBe('specialist');
    expect(refuteEntry(tracked(), 'k-1', 'wrong', 'human')).toBe(true);
    expect(refuteEntry(tracked(), 'nope', 'wrong', 'human')).toBe(false);
    const events = readKnowledgeLog(tracked());
    expect(events.map((e) => e.event)).toEqual(['promoted', 'refuted']);
    const lines = auditLines(events);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('proof=decision-id:DEC-0091');
    expect(authority()).toBe('inferred');
  });

  it('re-observation moves confidence 30 percent toward the value, authority unchanged', () => {
    repo({}, { authority: 'specialist' });
    expect(reobserveEntry(tracked(), 'k-1', 1, '2026-10-28')).toBeCloseTo(0.65);
    expect(authority()).toBe('specialist');
    expect(reobserveEntry(tracked(), 'nope', 1)).toBeNull();
    expect(readKnowledgeLog(tracked()).map((e) => e.event)).toEqual(['reobserved']);
  });

  it('caps re-observed confidence for agent-written entries', () => {
    repo({}, { writtenBy: 'agent', reverify: 'x', confidence: 0.85 });
    expect(reobserveEntry(tracked(), 'k-1', 1)).toBe(0.85);
  });
});

describe('cli-context promote/audit', () => {
  it('refuses an unknown proof kind via the CLI, promotes via path-exists, audits', async () => {
    repo();
    await buildContextCli([
      'promote',
      'k-1',
      '--proof',
      'bash:ls',
      '--project-dir',
      root,
    ]).parseAsync();
    expect(process.exitCode).toBe(1);
    expect(authority()).toBe('inferred');
    process.exitCode = 0;
    await buildContextCli([
      'promote',
      'k-1',
      '--proof',
      'path-exists:src/a.test.ts',
      '--project-dir',
      root,
    ]).parseAsync();
    expect(authority()).toBe('specialist');
    await buildContextCli(['audit', '--project-dir', root]).parseAsync();
    await buildContextCli([
      'reobserve',
      'k-1',
      '--confidence',
      '1',
      '--project-dir',
      root,
    ]).parseAsync();
    await buildContextCli(['refute', 'k-1', '--reason', 'r', '--project-dir', root]).parseAsync();
    expect(authority()).toBe('inferred');
    await buildContextCli([
      'promote',
      'k-1',
      '--to',
      'canonical',
      '--project-dir',
      root,
    ]).parseAsync();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await buildContextCli([
      'reobserve',
      'zz',
      '--confidence',
      '1',
      '--project-dir',
      root,
    ]).parseAsync();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await buildContextCli(['refute', 'zz', '--reason', 'r', '--project-dir', root]).parseAsync();
    expect(process.exitCode).toBe(1);
  });
});
