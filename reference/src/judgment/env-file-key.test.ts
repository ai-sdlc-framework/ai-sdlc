import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveJudgmentConfig } from './config.js';
import type { JudgmentDefinition } from './definition.js';
import {
  clearEnvFileKeyCache,
  parseEnvFileKey,
  readEnvFileKey,
  resolveEnvFileRoot,
} from './env-file-key.js';
import { evaluateJudgment } from './evaluate.js';
import { createJevProvider } from './jev-provider.js';
import { createJudgmentLogSink } from './log-sink.js';

const KEY = 'fixture-typesafe-key-aisdlc-1442';
const OTHER = 'fixture-unrelated-value-aisdlc-1442';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jev-envfile-'));
  clearEnvFileKeyCache();
  vi.stubEnv('TYPESAFE_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearEnvFileKeyCache();
  rmSync(root, { recursive: true, force: true });
});

const writeEnv = (text: string) => writeFileSync(join(root, '.env'), text);

const def = {
  id: 'test.envfile',
  version: 1,
  egressClass: 'work-item-text',
  direction: 'tighten-only',
  riskClass: 'seam',
  fallback: 'pending',
  buildState: (i: { text: string }) => ({ text: i.text }),
  questions: () => ({ q1: { type: 'noul', instructions: 'Is it fine?' } }),
  compose: () => ({ kind: 'act', decision: { ok: true } }),
} as unknown as JudgmentDefinition<{ text: string }, { ok: boolean }>;

describe('parseEnvFileKey', () => {
  it('reads only the named variable, with export, quotes and comments', () => {
    expect(parseEnvFileKey(`OTHER=${OTHER}\nTYPESAFE_API_KEY=${KEY}\n`, 'TYPESAFE_API_KEY')).toBe(
      KEY,
    );
    expect(parseEnvFileKey(`export TYPESAFE_API_KEY = "${KEY}"`, 'TYPESAFE_API_KEY')).toBe(KEY);
    expect(parseEnvFileKey(`TYPESAFE_API_KEY='${KEY}'`, 'TYPESAFE_API_KEY')).toBe(KEY);
    expect(parseEnvFileKey(`TYPESAFE_API_KEY=${KEY} # note`, 'TYPESAFE_API_KEY')).toBe(KEY);
    expect(parseEnvFileKey('TYPESAFE_API_KEY_OLD=x\n', 'TYPESAFE_API_KEY')).toBeUndefined();
    expect(parseEnvFileKey('TYPESAFE_API_KEY=\n', 'TYPESAFE_API_KEY')).toBeUndefined();
    expect(parseEnvFileKey('# TYPESAFE_API_KEY=x', 'TYPESAFE_API_KEY')).toBeUndefined();
  });
});

describe('readEnvFileKey', () => {
  it('returns undefined for a missing file and caches per process', () => {
    expect(readEnvFileKey('TYPESAFE_API_KEY', { projectRoot: root })).toBeUndefined();
    writeEnv(`TYPESAFE_API_KEY=${KEY}\n`);
    // cached: the file written after the first read is not seen
    expect(readEnvFileKey('TYPESAFE_API_KEY', { projectRoot: root })).toBeUndefined();
    clearEnvFileKeyCache();
    expect(readEnvFileKey('TYPESAFE_API_KEY', { projectRoot: root })).toBe(KEY);
  });

  it('returns undefined for an unreadable file', () => {
    writeEnv(`TYPESAFE_API_KEY=${KEY}\n`);
    chmodSync(join(root, '.env'), 0o000);
    try {
      const v = readEnvFileKey('TYPESAFE_API_KEY', { projectRoot: root });
      // root can read a 000 file; elsewhere the read fails closed
      if (process.getuid?.() !== 0) expect(v).toBeUndefined();
    } finally {
      chmodSync(join(root, '.env'), 0o600);
    }
  });

  it('resolves the project root from a directory outside any repository to itself', () => {
    expect(resolveEnvFileRoot(root)).toBe(root);
    expect(resolveEnvFileRoot(root)).toBe(root); // cached
    expect(readEnvFileKey('TYPESAFE_API_KEY', { cwd: root })).toBeUndefined();
  });
});

describe('jev provider key resolution (AISDLC-1442)', () => {
  it('falls back to the .env key without touching process.env or reading other variables', async () => {
    writeEnv(`OTHER_VAR=${OTHER}\nTYPESAFE_API_KEY=${KEY}\n`);
    const before = { ...process.env };
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: { q1: { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
        { status: 200 },
      );
    });
    const p = createJevProvider({ projectRoot: root, fetchImpl: f as unknown as typeof fetch });
    expect(await p.isAvailable()).toEqual({ available: true });
    const res = await p.evaluate({
      state: 's',
      consumerLabel: 't',
      questions: { q1: { type: 'noul', instructions: 'i' } },
    });
    expect(res.answers.q1).toEqual({ type: 'noul', probability: 0.9 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(process.env).toEqual(before);
    expect(JSON.stringify(process.env)).not.toContain(OTHER);
    expect(JSON.stringify(p)).not.toContain(OTHER);
  });

  it('an exported value wins over the .env', async () => {
    writeEnv(`TYPESAFE_API_KEY=${KEY}\n`);
    vi.stubEnv('TYPESAFE_API_KEY', 'exported-key');
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer exported-key');
      return new Response('{}', { status: 401 });
    });
    const p = createJevProvider({ projectRoot: root, fetchImpl: f as unknown as typeof fetch });
    await expect(
      p.evaluate({
        state: 's',
        consumerLabel: 't',
        questions: { q1: { type: 'noul', instructions: 'i' } },
      }),
    ).rejects.toThrow('401');
  });

  it('a missing .env yields the disabled abstain, no throw', async () => {
    const p = createJevProvider({ projectRoot: root });
    const out = await evaluateJudgment(
      def,
      { text: 'x' },
      {
        config: resolveJudgmentConfig({ spec: { provider: 'jev', model: 'jev-1.13.0' } }),
        getProvider: () => p,
      },
    );
    expect(out).toEqual({ kind: 'abstain', reason: 'disabled' });
  });

  it('under Vitest without a projectRoot the .env fallback is not consulted', async () => {
    expect(await createJevProvider({}).isAvailable()).toMatchObject({ available: false });
  });

  it('never puts the key in logs, the judgment log, errors or thrown messages', async () => {
    writeEnv(`TYPESAFE_API_KEY=${KEY}\n`);
    const captured: string[] = [];
    const capture = (...args: unknown[]) => void captured.push(args.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      captured.push(String(c));
      return true;
    });
    const artifactsDir = join(root, 'artifacts');
    const failing = vi.fn(async () => {
      throw new Error(`connect refused for token ${KEY}`);
    });
    const p = createJevProvider({
      projectRoot: root,
      fetchImpl: failing as unknown as typeof fetch,
      maxRetries: 0,
    });
    let thrown = '';
    try {
      await p.evaluate({
        state: 's',
        consumerLabel: 't',
        questions: { q1: { type: 'noul', instructions: 'i' } },
      });
    } catch (e) {
      thrown = `${(e as Error).message} ${(e as Error).stack ?? ''}`;
    }
    expect(thrown).toContain('[redacted]');
    const out = await evaluateJudgment(
      def,
      { text: 'x' },
      {
        config: resolveJudgmentConfig({ spec: { provider: 'jev', model: 'jev-1.13.0' } }),
        getProvider: () => p,
        sinks: [createJudgmentLogSink({ artifactsDir })],
      },
    );
    expect(out).toEqual({ kind: 'abstain', reason: 'provider-error' });
    stderr.mockRestore();
    const logDir = join(artifactsDir, '_judgment');
    const log = readdirSync(logDir)
      .map((f) => readFileSync(join(logDir, f), 'utf8'))
      .join('');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(KEY);
    expect(thrown).not.toContain(KEY);
    expect(captured.join('\n')).not.toContain(KEY);
  });
});
