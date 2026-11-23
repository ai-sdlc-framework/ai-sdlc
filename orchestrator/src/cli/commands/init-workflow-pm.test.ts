import { describe, it, expect } from 'vitest';
import { applyFeatureSelection, NO_FEATURES, type FeatureAdapters } from './init-features.js';
import { AI_SDLC_GATE_WORKFLOW, DOR_INGRESS_WORKFLOW } from './init-templates.js';

const GATE = '/proj/.github/workflows/ai-sdlc-gate.yml';
const DOR = '/proj/.github/workflows/dor-ingress.yml';
const flags = { yes: true, dryRun: false, force: false, add: false } as never;

function run(files: Record<string, string> | object, dryRun = false) {
  const state = new Map<string, string>(
    Object.entries(files as Record<string, string>).map(([k, v]) => [`/proj/${k}`, v]),
  );
  const log: string[] = [];
  const adapters = {
    prompt: async () => false,
    writeFile: (p: string, c: string) => void state.set(p, c),
    appendOnce: () => 'skipped',
    mkdirp: () => undefined,
    readTextFile: (p: string) => state.get(p) ?? null,
    exists: (p: string) => state.has(p),
    removeFile: (p: string) => void state.delete(p),
    chmodExecutable: () => undefined,
    realpath: (p: string) => (state.has(p) ? p : null),
    isSymlink: () => false,
    runCommand: () => ({ stdout: '', exitCode: 1 }),
    log: (m: string) => void log.push(m),
  } as unknown as FeatureAdapters;
  return applyFeatureSelection(
    '/proj',
    { ...NO_FEATURES, dor: true },
    { ...(flags as object), dryRun } as never,
    adapters,
  ).then((result) => ({ state, log, result }));
}

const needsOf = (s: string) => s.slice(s.indexOf('  pr-ready:'));

describe('init workflows follow the package manager (AISDLC-1362)', () => {
  it('AC1: pnpm and no package.json keep the template bytes', async () => {
    for (const files of [{ 'package.json': '{}', 'pnpm-lock.yaml': '' }, {}]) {
      const { state } = await run(files);
      expect(state.get(GATE)).toBe(AI_SDLC_GATE_WORKFLOW);
      expect(state.get(DOR)).toBe(DOR_INGRESS_WORKFLOW);
    }
  });

  it('AC2: npm', async () => {
    const { state } = await run({ 'package.json': '{}', 'package-lock.json': '' });
    const gate = state.get(GATE) as string;
    expect(gate).toContain('cache: npm');
    expect(gate).toContain('npm ci');
    expect(gate).toContain('npm run lint');
    expect(gate).toContain('npm run test:coverage');
    expect(gate).not.toContain('pnpm');
    expect(state.get(DOR)).toContain('npm ci');
  });

  it('AC3: yarn classic and berry', async () => {
    const classic = (await run({ 'package.json': '{}', 'yarn.lock': '' })).state.get(GATE);
    expect(classic).toContain('yarn install --frozen-lockfile');
    expect(classic).toContain('cache: yarn');
    const rc = await run({ 'package.json': '{}', 'yarn.lock': '', '.yarnrc.yml': '' });
    expect(rc.state.get(GATE)).toContain('yarn install --immutable');
    const field = await run({
      'package.json': '{"packageManager":"yarn@4.1.0"}',
      'yarn.lock': '',
    });
    expect(field.state.get(GATE)).toContain('yarn install --immutable');
  });

  it('AC4: bun', async () => {
    for (const lock of ['bun.lockb', 'bun.lock']) {
      const gate = (await run({ 'package.json': '{}', [lock]: '' })).state.get(GATE) as string;
      expect(gate).toContain('oven-sh/setup-bun');
      expect(gate).toContain('bun install --frozen-lockfile');
      expect(gate).toContain('bun run build');
      expect(gate).not.toContain('cache:');
      expect(gate).not.toContain('pnpm');
    }
  });

  it('AC5: packageManager field, and the pnpm default', async () => {
    const npm = await run({ 'package.json': '{"packageManager":"npm@10.0.0"}' });
    expect(npm.state.get(GATE)).toContain('npm ci');
    const none = await run({ 'package.json': '{}' });
    expect(none.state.get(GATE)).toBe(AI_SDLC_GATE_WORKFLOW);
  });

  it('AC6: needs list and pr-ready job are the same for every manager', async () => {
    const base = needsOf(AI_SDLC_GATE_WORKFLOW);
    for (const lock of ['package-lock.json', 'yarn.lock', 'bun.lock']) {
      const { state } = await run({ 'package.json': '{}', [lock]: '' });
      expect(needsOf(state.get(GATE) as string)).toBe(base);
    }
  });

  it('AC7: output names the manager and the missing test:coverage script', async () => {
    const missing = await run({ 'package.json': '{}', 'package-lock.json': '' });
    expect(
      missing.log.some((l) => l.includes('package manager: npm') && l.includes('ai-sdlc-gate.yml')),
    ).toBe(true);
    expect(missing.log.some((l) => l.includes('no test:coverage script'))).toBe(true);
    const present = await run({
      'package.json': '{"scripts":{"test:coverage":"vitest --coverage"}}',
      'package-lock.json': '',
    });
    expect(present.log.some((l) => l.includes('test:coverage'))).toBe(false);
    const broken = await run({ 'package.json': '{nope', 'package-lock.json': '' });
    expect(broken.log.some((l) => l.includes('no test:coverage script'))).toBe(true);
  });

  it('AC8: no-package.json note unchanged, dry run lists the same paths', async () => {
    const none = await run({});
    expect(none.log.some((l) => l.includes('no package.json found'))).toBe(true);
    const a = await run({ 'package.json': '{}' }, true);
    const b = await run({ 'package.json': '{}', 'yarn.lock': '' }, true);
    expect(b.result.wouldCreate).toEqual(a.result.wouldCreate);
  });
});
