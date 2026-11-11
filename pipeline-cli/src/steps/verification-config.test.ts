import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadVerification, scaffoldVerification } from './verification-config.js';
import {
  DEFAULT_VERIFICATION,
  DEFAULT_VERIFY_COMMANDS,
  resolveVerification,
  verificationCommandList,
} from './verify-defaults.js';
import { buildFinalSummary } from './10-finalize.js';
import { buildDeveloperPrompt } from './05-build-dev-prompt.js';
import type { DeveloperReturn } from '../types.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'verif-'));
const write = (root: string, yaml: string): void => {
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'verification.yaml'), yaml);
};

describe('resolveVerification', () => {
  it('falls back to the pnpm defaults when the block is absent', () => {
    expect(resolveVerification(undefined)).toEqual(DEFAULT_VERIFICATION);
    expect(resolveVerification([])).toEqual(DEFAULT_VERIFICATION);
    expect(verificationCommandList(resolveVerification(null))).toEqual([
      ...DEFAULT_VERIFY_COMMANDS,
    ]);
    expect(loadVerification(tmp())).toEqual(DEFAULT_VERIFICATION);
  });
  it('reads the block and omits unconfigured keys', () => {
    expect(resolveVerification({ test: ' go test ./... ', lint: 3, build: '' })).toEqual({
      test: 'go test ./...',
    });
    const root = tmp();
    write(root, 'verification:\n  test: pytest\n');
    expect(loadVerification(root)).toEqual({ test: 'pytest' });
  });
  it('keeps defaults on invalid yaml', () => {
    const root = tmp();
    write(root, ': : [');
    expect(loadVerification(root)).toEqual(DEFAULT_VERIFICATION);
  });
});

describe('scaffoldVerification', () => {
  it('writes pnpm defaults for package.json', () => {
    const root = tmp();
    writeFileSync(join(root, 'package.json'), '{}');
    expect(scaffoldVerification(root)).toBe('.ai-sdlc/verification.yaml');
    expect(loadVerification(root)).toEqual(DEFAULT_VERIFICATION);
    expect(scaffoldVerification(root)).toBeUndefined();
  });
  it('writes uv defaults for pyproject.toml', () => {
    const root = tmp();
    writeFileSync(join(root, 'pyproject.toml'), '');
    scaffoldVerification(root);
    expect(loadVerification(root).test).toBe('uv run pytest');
    expect(readFileSync(join(root, '.ai-sdlc/verification.yaml'), 'utf8')).toContain(
      'verification:',
    );
  });
  it('writes nothing for an unrecognised repo', () => {
    const root = tmp();
    expect(scaffoldVerification(root)).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('steps read the resolver', () => {
  const dev = {
    summary: 's',
    filesChanged: [],
    verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
    acceptanceCriteriaMet: [],
  } as unknown as DeveloperReturn;
  const task = { title: 't', description: 'd', acceptanceCriteria: ['a'] } as never;

  it('Step 10 prints skipped (not configured) for an omitted key', () => {
    const root = tmp();
    write(root, 'verification:\n  test: pytest\n');
    const { finalSummary } = buildFinalSummary({
      taskId: 'X-1',
      workDir: root,
      worktreePath: root,
      task,
      developerReturn: dev,
      verdict: { decision: 'APPROVED' } as never,
      iterations: 1,
    });
    expect(finalSummary).toContain('- `pytest` — passed');
    expect(finalSummary).toContain('- `build` — skipped (not configured)');
    expect(finalSummary).not.toContain('pnpm');
  });

  it('Step 5 lists the configured commands', async () => {
    const root = tmp();
    write(root, 'verification:\n  test: pytest\n');
    const r = await buildDeveloperPrompt({
      taskId: 'X-1',
      task,
      branch: 'b',
      worktreePath: root,
      projectRoot: root,
      artifactsDir: tmp(),
    });
    expect(r.prompt).toContain('- pytest\n');
    expect(r.prompt).not.toContain('pnpm');
  });

  it('steps 5, 10 and 11 contain no literal pnpm verification command', () => {
    for (const f of ['05-build-dev-prompt', '10-finalize', '11-push-and-pr']) {
      const src = readFileSync(join(__dirname, `${f}.ts`), 'utf8');
      expect(src).not.toMatch(/pnpm (build|test|lint|format:check)/);
    }
  });
});
