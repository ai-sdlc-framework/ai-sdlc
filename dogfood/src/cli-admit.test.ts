import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The scoreIssueForAdmission / enrichAdmissionInput spies are set per-test
// via vi.hoisted so `vi.mock` can reference them at module-initialization.
const mocks = vi.hoisted(() => ({
  scoreIssueForAdmission: vi.fn(() => ({
    admitted: true,
    score: {
      composite: 0.42,
      dimensions: {
        soulAlignment: 0.6,
        demandPressure: 0.4,
        marketForce: 1,
        executionReality: 0.7,
        entropyTax: 0,
        humanCurve: 0.1,
        calibration: 1,
      },
      confidence: 0.5,
      timestamp: '2026-04-24T00:00:00Z',
    },
    reason: 'ok',
    pillarBreakdown: {
      product: {
        pillar: 'product',
        governedDimensions: ['SA-1', 'D-pi', 'HC_explicit'],
        signal: 0.5,
        interpretation: 'neutral Product signal',
      },
      design: {
        pillar: 'design',
        governedDimensions: ['ER-4', 'HC_design'],
        signal: 0.8,
        interpretation: 'strong Design signal',
      },
      engineering: {
        pillar: 'engineering',
        governedDimensions: ['ER-1', 'ER-2', 'ER-3'],
        signal: 0.5,
        interpretation: 'neutral Engineering signal',
      },
      shared: {
        hcComposite: { explicit: 0, consensus: 0, decision: 0, design: 0, value: 0 },
      },
      tensions: [],
    },
  })),
  enrichAdmissionInput: vi.fn((input: unknown, _ctx: unknown) => {
    void _ctx;
    return input;
  }),
  stateStoreOpen: vi.fn(() => ({ close: vi.fn() })),
  loadConfigAsync: vi.fn().mockResolvedValue({
    pipeline: { spec: { priorityPolicy: { minimumScore: 0.05, minimumConfidence: 0.2 } } },
    designSystemBindings: [
      {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'DesignSystemBinding',
        metadata: { name: 'acme-ds' },
        spec: {},
      },
    ],
    designIntentDocuments: [
      {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'DesignIntentDocument',
        metadata: { name: 'acme-did' },
        spec: {},
      },
    ],
    autonomyPolicy: {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'AutonomyPolicy',
      metadata: { name: 'acme-ap' },
      spec: {},
      status: { agents: [{ name: 'devloop', currentLevel: 2 }] },
    },
  }),
  resolveRepoRoot: vi.fn(),
  loadBacklogTaskFromRoot: vi.fn(() => ({
    id: 'AISDLC-42',
    numericId: 42,
    title: 'Backlog task',
    description: 'desc',
    status: 'To Do',
    priority: 'high',
    labels: ['priority:p1', 'size:M'],
    createdDate: '2026-04-25 09:00',
    updatedDate: '2026-04-25 09:00',
    acceptanceCriteria: [],
    references: [],
  })),
  parseBacklogTask: vi.fn((content: string) => ({
    id: 'TASK-FILE-1',
    numericId: 1,
    title: 'parsed from file',
    description: content.slice(0, 50),
    status: 'To Do',
    priority: null,
    labels: ['source:rfc'],
    createdDate: '2026-04-25 09:00',
    updatedDate: '2026-04-25 09:00',
    acceptanceCriteria: [],
    references: [],
  })),
  mapBacklogTaskToAdmissionInput: vi.fn(
    (snap: { id: string; title: string; numericId: number }) => ({
      input: {
        issueNumber: snap.numericId,
        title: snap.title,
        body: 'mapped body',
        labels: ['priority:p1'],
        reactionCount: 0,
        commentCount: 0,
        createdAt: '2026-04-25T09:00:00Z',
        authorAssociation: 'MEMBER' as const,
      },
      priorityInputOverrides: { explicitPriority: 0.75, complexity: 5 },
      qualityFlags: [],
    }),
  ),
  loadSoulTracks: vi.fn(() => ({})),
  loadMaintainers: vi.fn(() => [] as string[]),
}));

vi.mock('@ai-sdlc/orchestrator', () => ({
  DEFAULT_CONFIG_DIR_NAME: '.ai-sdlc',
  loadConfigAsync: mocks.loadConfigAsync,
  resolveRepoRoot: mocks.resolveRepoRoot,
  scoreIssueForAdmission: mocks.scoreIssueForAdmission,
  enrichAdmissionInput: mocks.enrichAdmissionInput,
  StateStore: { open: mocks.stateStoreOpen },
  loadBacklogTaskFromRoot: mocks.loadBacklogTaskFromRoot,
  parseBacklogTask: mocks.parseBacklogTask,
  mapBacklogTaskToAdmissionInput: mocks.mapBacklogTaskToAdmissionInput,
  loadSoulTracks: mocks.loadSoulTracks,
  loadMaintainers: mocks.loadMaintainers,
}));

describe('cli-admit.ts', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;
  let bodyFile: string;

  beforeEach(() => {
    originalArgv = process.argv;
    // @ts-expect-error — spying on process.exit in tests
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'admit-test-'));
    bodyFile = join(tempDir, 'body.txt');
    writeFileSync(bodyFile, '### Complexity\n3\n');

    mocks.scoreIssueForAdmission.mockClear();
    mocks.enrichAdmissionInput.mockClear();
    mocks.stateStoreOpen.mockClear();
    mocks.loadBacklogTaskFromRoot.mockClear();
    mocks.parseBacklogTask.mockClear();
    mocks.mapBacklogTaskToAdmissionInput.mockClear();
    mocks.loadSoulTracks.mockClear();
    mocks.loadMaintainers.mockClear();
    mocks.resolveRepoRoot.mockResolvedValue(tempDir);
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('AC #1: without --enrich-from-state, does NOT call enrichAdmissionInput (stateless)', async () => {
    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      'fix thing',
      '--body-file',
      bodyFile,
      '--issue-number',
      '7',
      '--labels',
      '["bug"]',
      '--reactions',
      '2',
      '--comments',
      '1',
      '--created-at',
      '2026-04-01T00:00:00Z',
      '--author-association',
      'OWNER',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.scoreIssueForAdmission).toHaveBeenCalledTimes(1);
    expect(mocks.enrichAdmissionInput).not.toHaveBeenCalled();
    expect(mocks.stateStoreOpen).not.toHaveBeenCalled();
  });

  it('AC #2: with --enrich-from-state, calls enrichAdmissionInput with resolved refs', async () => {
    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      'fix thing',
      '--body-file',
      bodyFile,
      '--issue-number',
      '7',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
      '--author-association',
      'MEMBER',
      '--author-login',
      'alice',
      '--code-area',
      'components/Button.tsx',
      '--enrich-from-state',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.enrichAdmissionInput).toHaveBeenCalledTimes(1);
    const [admissionInput, ctx] = mocks.enrichAdmissionInput.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(admissionInput.authorLogin).toBe('alice');
    expect(ctx.codeArea).toBe('components/Button.tsx');
    expect((ctx.designSystemBinding as { metadata: { name: string } }).metadata.name).toBe(
      'acme-ds',
    );
    expect((ctx.designIntentDocument as { metadata: { name: string } }).metadata.name).toBe(
      'acme-did',
    );
    expect((ctx.autonomyPolicy as { metadata: { name: string } }).metadata.name).toBe('acme-ap');
  });

  it('AC #4: JSON output includes pillarBreakdown with tension array', async () => {
    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      't',
      '--body-file',
      bodyFile,
      '--issue-number',
      '1',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.pillarBreakdown).toBeDefined();
    expect(parsed.pillarBreakdown.product).toBeDefined();
    expect(parsed.pillarBreakdown.design).toBeDefined();
    expect(parsed.pillarBreakdown.engineering).toBeDefined();
    expect(Array.isArray(parsed.pillarBreakdown.tensions)).toBe(true);
  });

  it('honours --design-system-ref when multiple bindings exist', async () => {
    mocks.loadConfigAsync.mockResolvedValueOnce({
      pipeline: { spec: { priorityPolicy: {} } },
      designSystemBindings: [
        {
          apiVersion: 'ai-sdlc.io/v1alpha1',
          kind: 'DesignSystemBinding',
          metadata: { name: 'team-a' },
          spec: {},
        },
        {
          apiVersion: 'ai-sdlc.io/v1alpha1',
          kind: 'DesignSystemBinding',
          metadata: { name: 'team-b' },
          spec: {},
        },
      ],
    });

    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      't',
      '--body-file',
      bodyFile,
      '--issue-number',
      '1',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
      '--enrich-from-state',
      '--design-system-ref',
      'team-b',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    const [, ctx] = mocks.enrichAdmissionInput.mock.calls[0] as [unknown, Record<string, unknown>];
    expect((ctx.designSystemBinding as { metadata: { name: string } }).metadata.name).toBe(
      'team-b',
    );
  });

  it('AC #3: workflow stays backward-compat when .ai-sdlc config is absent', async () => {
    mocks.loadConfigAsync.mockResolvedValueOnce({});
    mocks.resolveRepoRoot.mockResolvedValueOnce(tempDir);

    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      't',
      '--body-file',
      bodyFile,
      '--issue-number',
      '1',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
      '--enrich-from-state', // flag present even though config absent
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    // enrichAdmissionInput still called (with empty ctx → returns input unchanged)
    expect(mocks.enrichAdmissionInput).toHaveBeenCalled();
    const [, ctx] = mocks.enrichAdmissionInput.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(ctx.designSystemBinding).toBeUndefined();
    expect(ctx.designIntentDocument).toBeUndefined();
    expect(ctx.autonomyPolicy).toBeUndefined();
    expect(mocks.scoreIssueForAdmission).toHaveBeenCalled();
  });

  it('Backlog tracker via --task-id dispatches to loadBacklogTaskFromRoot + mapBacklogTaskToAdmissionInput', async () => {
    process.argv = [
      'node',
      'cli-admit.ts',
      '--tracker',
      'backlog',
      '--task-id',
      'AISDLC-42',
      '--config-root',
      tempDir,
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.loadBacklogTaskFromRoot).toHaveBeenCalledWith(tempDir, 'AISDLC-42');
    expect(mocks.mapBacklogTaskToAdmissionInput).toHaveBeenCalledTimes(1);
    expect(mocks.parseBacklogTask).not.toHaveBeenCalled();
    expect(mocks.scoreIssueForAdmission).toHaveBeenCalledTimes(1);
    // priorityInputOverrides flow through to scoreIssueForAdmission's options arg
    const call = mocks.scoreIssueForAdmission.mock.calls[0] as unknown[];
    const options = call[3] as { priorityInputOverrides?: Record<string, unknown> } | undefined;
    expect(options).toBeDefined();
    expect(options?.priorityInputOverrides).toEqual({
      explicitPriority: 0.75,
      complexity: 5,
    });
  });

  it('Backlog tracker via --task-file dispatches to parseBacklogTask', async () => {
    const taskFile = join(tempDir, 'aisdlc-7.md');
    writeFileSync(taskFile, `---\nid: AISDLC-7\ntitle: From file\nstatus: To Do\n---\n\nbody`);
    process.argv = [
      'node',
      'cli-admit.ts',
      '--tracker',
      'backlog',
      '--task-file',
      taskFile,
      '--config-root',
      tempDir,
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.parseBacklogTask).toHaveBeenCalledTimes(1);
    expect(mocks.loadBacklogTaskFromRoot).not.toHaveBeenCalled();
    expect(mocks.mapBacklogTaskToAdmissionInput).toHaveBeenCalledTimes(1);
  });

  it('auto-detects Backlog tracker when --task-id is supplied with no --tracker flag', async () => {
    process.argv = ['node', 'cli-admit.ts', '--task-id', 'AISDLC-7', '--config-root', tempDir];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.loadBacklogTaskFromRoot).toHaveBeenCalledTimes(1);
    expect(mocks.mapBacklogTaskToAdmissionInput).toHaveBeenCalledTimes(1);
  });

  it('Backlog tracker exits 1 when neither --task-id nor --task-file is provided', async () => {
    process.argv = ['node', 'cli-admit.ts', '--tracker', 'backlog'];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--tracker backlog --task-id'));
  });

  it('Backlog tracker exits 1 when the task id is not found', async () => {
    (
      mocks.loadBacklogTaskFromRoot as unknown as { mockReturnValueOnce: (v: unknown) => void }
    ).mockReturnValueOnce(undefined);
    process.argv = [
      'node',
      'cli-admit.ts',
      '--tracker',
      'backlog',
      '--task-id',
      'NOPE-1',
      '--config-root',
      tempDir,
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Backlog task NOPE-1 not found'));
  });

  it('emits provenance JSON on stderr (tracker, configRoot, configSource)', async () => {
    process.argv = [
      'node',
      'cli-admit.ts',
      '--tracker',
      'backlog',
      '--task-id',
      'AISDLC-42',
      '--config-root',
      tempDir,
      '--enrich-from-state',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    const provenanceCall = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes('"provenance"'));
    expect(provenanceCall).toBeDefined();
    const parsed = JSON.parse(provenanceCall as string);
    expect(parsed.provenance.tracker).toBe('backlog');
    expect(parsed.provenance.configRoot).toBe(tempDir);
    expect(parsed.provenance.configSource).toBe('flag');
    expect(parsed.provenance.designSystemBinding).toBe('acme-ds');
    expect(parsed.provenance.designIntentDocument).toBe('acme-did');
    expect(parsed.provenance.autonomyPolicy).toBe('acme-ap');
  });

  it('emits a fallback warning on stderr when no .ai-sdlc/ ancestor is found', async () => {
    // resolveRepoRoot returns tempDir, no .ai-sdlc/ in it → cwd-walk fails
    // → fallback. The skill-side caller should see this WARN and confirm.
    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      't',
      '--body-file',
      bodyFile,
      '--issue-number',
      '1',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    const warnCall = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes('via fallback'));
    expect(warnCall).toBeDefined();
  });

  it('GitHub usage exits 1 when --title is missing', async () => {
    process.argv = ['node', 'cli-admit.ts', '--issue-number', '1'];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('admit --title'));
  });

  it('--config-root with task-file walks up to find .ai-sdlc and reports configSource=task-file', async () => {
    // Place a task file inside a sibling subdir; .ai-sdlc/ at tempDir.
    const subdir = join(tempDir, 'sub');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(subdir, { recursive: true });
    mkdirSync(join(tempDir, '.ai-sdlc'), { recursive: true });
    const taskFile = join(subdir, 'aisdlc-7.md');
    writeFileSync(taskFile, `---\nid: AISDLC-7\ntitle: t\nstatus: To Do\n---\n\nbody`);

    process.argv = [
      'node',
      'cli-admit.ts',
      '--tracker',
      'backlog',
      '--task-file',
      taskFile,
      // No --config-root — let the walk-up resolve it.
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    const provenance = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes('"provenance"'));
    expect(provenance).toBeDefined();
    const parsed = JSON.parse(provenance as string);
    expect(parsed.provenance.configSource).toBe('task-file');
    expect(parsed.provenance.configRoot).toBe(tempDir);
  });

  it('emits Warning on stderr when loadConfigAsync rejects', async () => {
    mocks.loadConfigAsync.mockRejectedValueOnce(new Error('disk full'));
    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      't',
      '--body-file',
      bodyFile,
      '--issue-number',
      '1',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    const warning = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes('could not load pipeline config'));
    expect(warning).toBeDefined();
  });

  it('attaches qualityFlags from the Backlog mapping onto the result', async () => {
    (
      mocks.mapBacklogTaskToAdmissionInput as unknown as {
        mockReturnValueOnce: (v: unknown) => void;
      }
    ).mockReturnValueOnce({
      input: {
        issueNumber: 42,
        title: 'zombie close',
        body: 'body',
        labels: ['priority:p1'],
        reactionCount: 0,
        commentCount: 0,
        createdAt: '2026-04-25T09:00:00Z',
        authorAssociation: 'MEMBER',
      },
      priorityInputOverrides: { defectRiskFactor: 0.3 },
      qualityFlags: [
        { kind: 'unchecked-acs-on-done', detail: '5/5 ACs unchecked', severity: 'high' },
      ],
    });
    process.argv = [
      'node',
      'cli-admit.ts',
      '--tracker',
      'backlog',
      '--task-id',
      'AISDLC-42',
      '--config-root',
      tempDir,
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.qualityFlags).toHaveLength(1);
    expect(parsed.qualityFlags[0].kind).toBe('unchecked-acs-on-done');
  });

  it('Backlog tracker auto-loads maintainers from .ai-sdlc/maintainers.yaml', async () => {
    mocks.loadMaintainers.mockReturnValueOnce(['alice', 'bob']);
    process.argv = [
      'node',
      'cli-admit.ts',
      '--tracker',
      'backlog',
      '--task-id',
      'AISDLC-42',
      '--config-root',
      tempDir,
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.loadMaintainers).toHaveBeenCalledWith(tempDir);
    const call = mocks.mapBacklogTaskToAdmissionInput.mock.calls[0] as unknown[];
    const opts = call[1] as { maintainers?: string[] };
    expect(opts.maintainers).toEqual(['alice', 'bob']);
  });

  it('explicit --maintainers flag (comma-separated) wins over the YAML loader', async () => {
    mocks.loadMaintainers.mockReturnValueOnce(['from-yaml']);
    process.argv = [
      'node',
      'cli-admit.ts',
      '--tracker',
      'backlog',
      '--task-id',
      'AISDLC-42',
      '--config-root',
      tempDir,
      '--maintainers',
      'alice, bob, carol',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.loadMaintainers).not.toHaveBeenCalled();
    const call = mocks.mapBacklogTaskToAdmissionInput.mock.calls[0] as unknown[];
    const opts = call[1] as { maintainers?: string[] };
    expect(opts.maintainers).toEqual(['alice', 'bob', 'carol']);
  });

  it('explicit --maintainers as JSON array is parsed correctly', async () => {
    process.argv = [
      'node',
      'cli-admit.ts',
      '--tracker',
      'backlog',
      '--task-id',
      'AISDLC-42',
      '--config-root',
      tempDir,
      '--maintainers',
      '["alice","bob"]',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    const call = mocks.mapBacklogTaskToAdmissionInput.mock.calls[0] as unknown[];
    const opts = call[1] as { maintainers?: string[] };
    expect(opts.maintainers).toEqual(['alice', 'bob']);
  });

  it('config warnings are surfaced on stderr and in the provenance line', async () => {
    mocks.loadConfigAsync.mockResolvedValueOnce({
      pipeline: { spec: { priorityPolicy: { minimumScore: 0.05, minimumConfidence: 0.2 } } },
      designSystemBindings: [],
      designIntentDocuments: [],
      warnings: [
        {
          file: 'adapter-binding.yaml',
          error: 'validation failed: spec/forwardLookingField not allowed',
        },
      ],
    });
    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      't',
      '--body-file',
      bodyFile,
      '--issue-number',
      '1',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
      '--enrich-from-state',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    const stderr = errorSpy.mock.calls.map((args) => String(args[0]));
    const skipped = stderr.find((line) => line.includes('skipped adapter-binding.yaml'));
    expect(skipped).toBeDefined();
    expect(skipped).toContain('forwardLookingField');

    const provenance = stderr.find((line) => line.includes('"provenance"'));
    expect(provenance).toBeDefined();
    const parsed = JSON.parse(provenance as string);
    expect(parsed.provenance.skippedConfigFiles).toHaveLength(1);
    expect(parsed.provenance.skippedConfigFiles[0].file).toBe('adapter-binding.yaml');
  });

  it('surfaces the actual error when loadConfigAsync rejects (no more "could not load" generic warning)', async () => {
    mocks.loadConfigAsync.mockRejectedValueOnce(new Error('schema_version table corrupt'));
    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      't',
      '--body-file',
      bodyFile,
      '--issue-number',
      '1',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    const stderr = errorSpy.mock.calls.map((args) => String(args[0]));
    const warning = stderr.find((line) => line.includes('could not load pipeline config'));
    expect(warning).toBeDefined();
    expect(warning).toContain('schema_version table corrupt');
  });
});
