import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  listCapabilities,
  getCapability,
  registerCapability,
  reportCapabilityOutcome,
  readCapabilityState,
  deriveCapabilityStatus,
} from './index.js';

const EXPECTED = [
  'classifier.capture-triage',
  'classifier.capture-severity',
  'classifier.pr-comment-is-capture',
  'classifier.dor-answer-is-new-concern',
  'decisions.stage-c-recommendation',
  'decisions.stage-b-signals',
  'dor.stage-b',
  'estimation.class-assignment',
  'estimation.stage-b',
  'sa.layer3',
  'review.meta-review',
  'policy.llm-evaluator',
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cap-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('registry', () => {
  it('has exactly the twelve built-in ids', () => {
    expect(listCapabilities().map((c) => c.id)).toEqual(EXPECTED);
    expect(getCapability('dor.stage-b')?.specifiedBy).toBe('RFC-0011');
  });
  it('rejects duplicates', () => {
    expect(() => registerCapability({ ...getCapability('sa.layer3')! })).toThrow(/already/);
  });
});

describe('reporting', () => {
  it('degraded then live', () => {
    const t = [new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z')];
    reportCapabilityOutcome('dor.stage-b', 'degraded', {
      artifactsDir: dir,
      reason: 'no backend',
      now: () => t[0],
    });
    reportCapabilityOutcome('dor.stage-b', 'live', { artifactsDir: dir, now: () => t[1] });
    const row = readCapabilityState(dir).find((r) => r.id === 'dor.stage-b')!;
    expect(row.counts).toEqual({ live: 1, shadow: 0, degraded: 1 });
    expect(row.lastLiveAt! > row.lastDegradedAt!).toBe(true);
    expect(row.lastDegradedReason).toBe('no backend');
    expect(row.status).toBe('live');
    reportCapabilityOutcome('dor.stage-b', 'shadow', { artifactsDir: dir });
    expect(readCapabilityState(dir).find((r) => r.id === 'dor.stage-b')!.lastShadowAt).toBeTruthy();
  });

  it('unreported capabilities are never-observed', () => {
    const rows = readCapabilityState(dir);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.status === 'never-observed')).toBe(true);
    expect(deriveCapabilityStatus(undefined)).toBe('never-observed');
  });

  it('records unknown ids as unregistered', () => {
    reportCapabilityOutcome('x.unknown', 'live', { artifactsDir: dir });
    const row = readCapabilityState(dir).find((r) => r.id === 'x.unknown')!;
    expect(row.unregistered).toBe(true);
    expect(row.status).toBe('live');
  });

  it('never throws on unwritable dir or corrupt file', () => {
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    expect(() =>
      reportCapabilityOutcome('dor.stage-b', 'live', { artifactsDir: join(blocker, 'sub') }),
    ).not.toThrow();
    mkdirSync(join(dir, '_capabilities'), { recursive: true });
    writeFileSync(join(dir, '_capabilities', 'state.json'), '{not json');
    expect(() =>
      reportCapabilityOutcome('dor.stage-b', 'live', { artifactsDir: dir }),
    ).not.toThrow();
    expect(readCapabilityState(dir).find((r) => r.id === 'dor.stage-b')!.counts.live).toBe(1);
  });

  it('gives up on a held lock without throwing or hanging', () => {
    mkdirSync(join(dir, '_capabilities'), { recursive: true });
    writeFileSync(join(dir, '_capabilities', 'state.lock'), '');
    const start = Date.now();
    expect(() =>
      reportCapabilityOutcome('dor.stage-b', 'live', { artifactsDir: dir }),
    ).not.toThrow();
    expect(Date.now() - start).toBeLessThan(10000);
  });

  it('state file holds no free-form input', () => {
    reportCapabilityOutcome('dor.stage-b', 'degraded', { artifactsDir: dir, reason: 'disabled' });
    const raw = readFileSync(join(dir, '_capabilities', 'state.json'), 'utf-8');
    expect(Object.keys(JSON.parse(raw))).toEqual(['version', 'capabilities']);
  });

  it('twenty concurrent processes sum to twenty', async () => {
    const stateTs = fileURLToPath(new URL('./state.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
    const script = join(dir, 'child.mts');
    writeFileSync(
      script,
      `import { reportCapabilityOutcome } from ${JSON.stringify(stateTs)};\n` +
        `reportCapabilityOutcome('dor.stage-b', process.argv[3] === '0' ? 'live' : 'degraded', { artifactsDir: process.argv[2] });\n`,
    );
    await Promise.all(
      Array.from(
        { length: 20 },
        (_, i) =>
          new Promise<void>((resolve, reject) => {
            const p = spawn(tsx, [script, dir, String(i % 2)], { stdio: 'ignore' });
            p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))));
          }),
      ),
    );
    const row = readCapabilityState(dir).find((r) => r.id === 'dor.stage-b')!;
    expect(row.counts.live + row.counts.degraded + row.counts.shadow).toBe(20);
  }, 60000);
});
