import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import {
  claimedGreenButRed,
  formatVerifyFeedback,
  recordDeveloperHonestyEvent,
  runVerifyCommands,
  verifyKeyFor,
  writeVerifyRunState,
} from './verify-commands.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const green = { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' } as const;

describe('runVerifyCommands', () => {
  it('records a red test with tail and keeps the developer claim', async () => {
    const fr = new FakeRunner().on(/pnpm test/, fail('boom\n'.repeat(100), 1));
    const run = await runVerifyCommands({
      commands: ['pnpm build', 'pnpm test', 'pnpm lint'],
      cwd: '/x',
      runner: fr.toRunner(),
      developerClaimed: green,
    });
    expect(run.ok).toBe(false);
    expect(run.failing?.command).toBe('pnpm test');
    expect(run.failing?.tail.split('\n')).toHaveLength(60);
    expect(run.verifications).toMatchObject({ build: 'passed', test: 'failed', lint: 'skipped' });
    expect(run.developerClaimed).toEqual(green);
    expect(claimedGreenButRed(run)).toBe(true);
    expect(formatVerifyFeedback(run)).toContain('pnpm test');
    expect(fr.calls).toHaveLength(2);
  });

  it('passes when all exit 0', async () => {
    const run = await runVerifyCommands({
      commands: ['pnpm build', 'pnpm format:check'],
      cwd: '/x',
      runner: new FakeRunner().on(/./, ok('fine')).toRunner(),
    });
    expect(run.ok).toBe(true);
    expect(run.verifications.format).toBe('passed');
    expect(claimedGreenButRed(run)).toBe(false);
    expect(formatVerifyFeedback(run)).toBe('');
  });

  it('skips docs-only', async () => {
    const run = await runVerifyCommands({ commands: [], cwd: '/x' });
    expect(run).toMatchObject({ ok: true, skipped: 'docs-only' });
  });

  it('enforces the per-command timeout', async () => {
    const run = await runVerifyCommands({
      commands: ['exec sleep 30'],
      cwd: tmpdir(),
      timeoutMs: 300,
    });
    expect(run.ok).toBe(false);
    expect(run.failing?.timedOut).toBe(true);
    expect(formatVerifyFeedback(run)).toContain('timed out');
  });

  it('maps commands to keys', () => {
    expect(verifyKeyFor('pnpm format:check')).toBe('format');
    expect(verifyKeyFor('echo hi')).toBeUndefined();
  });

  it('persists run state and honesty events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'));
    try {
      const run = await runVerifyCommands({
        commands: ['pnpm test'],
        cwd: '/x',
        runner: new FakeRunner().on(/./, fail('x')).toRunner(),
        developerClaimed: green,
      });
      writeVerifyRunState(dir, 'T-1', run);
      recordDeveloperHonestyEvent(dir, 'T-1', run);
      expect(JSON.parse(readFileSync(join(dir, 'verify-runs', 'T-1.json'), 'utf8')).ok).toBe(false);
      expect(
        readFileSync(join(dir, '.ai-sdlc', 'usage', 'developer-honesty.jsonl'), 'utf8'),
      ).toContain('developer-honesty');
      // unwritable target is swallowed
      writeVerifyRunState('/dev/null/x', 'T-1', run);
      recordDeveloperHonestyEvent('/dev/null/x', 'T-1', run);
    } finally {
      removeFixtureDir(dir);
    }
  });
});
