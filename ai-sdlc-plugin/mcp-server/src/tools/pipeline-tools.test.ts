/**
 * Unit tests for the 14 `pipeline_step_*` MCP tool wrappers
 * (RFC-0012 Phase 3 — AISDLC-100.3).
 *
 * Strategy:
 *  - Capture every `server.tool()` call into a registry so we can drive each
 *    handler directly without spinning up a real MCP server.
 *  - Mock every step function via `PipelineToolDeps.stepRunners` so we don't
 *    shell out to git/gh or touch the filesystem.
 *  - Mock the spawner factory via `PipelineToolDeps.spawnerFactory` so the
 *    Step 9 wrapper never invokes the real `defaultSpawner()` (which would
 *    throw — neither `claude` nor `ANTHROPIC_API_KEY` is present in the
 *    test environment).
 *  - Cover: registration shape (14 tools, naming, schemas), successful
 *    invocation, schema validation rejection, and error propagation.
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import {
  defaultStepRunners,
  registerPipelineTools,
  type PipelineToolDeps,
  type StepRunners,
} from './pipeline-tools.js';
import type {
  AggregatedVerdict,
  DeveloperReturn,
  SubagentSpawner,
  TaskSpec,
} from '@ai-sdlc/pipeline-cli';

// ── Test harness ─────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

function createServerStub(): { server: McpServer; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: ZodRawShape,
        handler: RegisteredTool['handler'],
      ) => {
        tools.push({ name, description, schema, handler });
      },
    ),
  } as unknown as McpServer;
  return { server, tools };
}

function makeRunnersWithDefaults(overrides: Partial<StepRunners> = {}): StepRunners {
  // Most tests only care about ONE step at a time; the rest stay no-op
  // mocks so accidental invocation surfaces immediately.
  const noop = vi.fn(async () => {
    throw new Error('unexpected step invocation');
  }) as unknown;
  return {
    sweepMergedWorktrees: noop as StepRunners['sweepMergedWorktrees'],
    validateTask: noop as StepRunners['validateTask'],
    computeBranchName: noop as StepRunners['computeBranchName'],
    setupWorktree: noop as StepRunners['setupWorktree'],
    beginTask: noop as StepRunners['beginTask'],
    buildDeveloperPrompt: noop as StepRunners['buildDeveloperPrompt'],
    parseDeveloperReturn: noop as StepRunners['parseDeveloperReturn'],
    buildReviewPrompts: noop as StepRunners['buildReviewPrompts'],
    aggregateVerdicts: noop as StepRunners['aggregateVerdicts'],
    iterateReviewLoop: noop as StepRunners['iterateReviewLoop'],
    finalizeTask: noop as StepRunners['finalizeTask'],
    pushAndPr: noop as StepRunners['pushAndPr'],
    siblingPrs: noop as StepRunners['siblingPrs'],
    cleanupTask: noop as StepRunners['cleanupTask'],
    ...overrides,
  };
}

const FAKE_TASK: TaskSpec = {
  id: 'AISDLC-100.3',
  title: 'Phase 3 — wrap pipeline steps as MCP tools',
  status: 'In Progress',
  acceptanceCriteria: ['AC1', 'AC2'],
  acceptanceCriteriaChecked: [false, false],
  description: 'Test fixture',
  rawBody: '## Description\nTest fixture',
  filePath: '/tmp/fake-task.md',
};

const FAKE_DEV_RETURN: DeveloperReturn = {
  summary: 'shipped',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1, 2],
};

const FAKE_VERDICT: AggregatedVerdict = {
  approved: true,
  counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  decision: 'APPROVED',
  verdicts: [],
  harnessNote: '',
  summary: 'Verdict: APPROVED — 0/0/0/0 across 0 reviewers',
};

const EXPECTED_TOOL_NAMES = [
  'pipeline_step_0_sweep',
  'pipeline_step_1_validate',
  'pipeline_step_2_compute_branch',
  'pipeline_step_3_setup_worktree',
  'pipeline_step_4_begin_task',
  'pipeline_step_5_build_dev_prompt',
  'pipeline_step_6_parse_dev_return',
  'pipeline_step_7_build_review_prompts',
  'pipeline_step_8_aggregate_verdicts',
  'pipeline_step_9_iterate',
  'pipeline_step_10_finalize',
  'pipeline_step_11_push_and_pr',
  'pipeline_step_12_sibling_prs',
  'pipeline_step_13_cleanup',
];

function getTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('registerPipelineTools — registration shape', () => {
  it('registers exactly 14 tools — one per Step 0-13', () => {
    const { server, tools } = createServerStub();
    registerPipelineTools(server, { spawnerFactory: async () => ({}) as SubagentSpawner });
    expect(tools).toHaveLength(14);
  });

  it('uses the canonical pipeline_step_<N>_<name> naming convention', () => {
    const { server, tools } = createServerStub();
    registerPipelineTools(server, { spawnerFactory: async () => ({}) as SubagentSpawner });
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('every tool has a non-empty description', () => {
    const { server, tools } = createServerStub();
    registerPipelineTools(server, { spawnerFactory: async () => ({}) as SubagentSpawner });
    for (const t of tools) {
      expect(t.description.length, `${t.name} description must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('every tool has an input schema (zod raw shape)', () => {
    const { server, tools } = createServerStub();
    registerPipelineTools(server, { spawnerFactory: async () => ({}) as SubagentSpawner });
    for (const t of tools) {
      expect(t.schema, `${t.name} must register a schema`).toBeTypeOf('object');
      // Sanity: the schema must wrap into a zod object successfully.
      expect(() => z.object(t.schema)).not.toThrow();
    }
  });

  it('exports defaultStepRunners pointing at the live step functions', () => {
    expect(Object.keys(defaultStepRunners).sort()).toEqual(
      [
        'aggregateVerdicts',
        'beginTask',
        'buildDeveloperPrompt',
        'buildReviewPrompts',
        'cleanupTask',
        'computeBranchName',
        'finalizeTask',
        'iterateReviewLoop',
        'parseDeveloperReturn',
        'pushAndPr',
        'setupWorktree',
        'siblingPrs',
        'sweepMergedWorktrees',
        'validateTask',
      ].sort(),
    );
    for (const fn of Object.values(defaultStepRunners)) {
      expect(typeof fn).toBe('function');
    }
  });
});

describe('pipeline_step_0_sweep', () => {
  function setup(deps: PipelineToolDeps = {}) {
    const { server, tools } = createServerStub();
    registerPipelineTools(server, deps);
    return getTool(tools, 'pipeline_step_0_sweep');
  }

  it('invokes sweepMergedWorktrees and returns JSON-encoded result', async () => {
    const sweep = vi.fn(async () => ({
      swept: [{ worktreePath: '/tmp/wt', branch: 'b', mergedAt: '2026-01-01T00:00:00Z' }],
    }));
    const tool = setup({
      stepRunners: { sweepMergedWorktrees: sweep },
    });
    const result = await tool.handler({ workDir: '/tmp/proj' });
    expect(sweep).toHaveBeenCalledWith({ workDir: '/tmp/proj' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      swept: [{ worktreePath: '/tmp/wt', branch: 'b', mergedAt: '2026-01-01T00:00:00Z' }],
    });
  });

  it('rejects calls missing workDir at zod validation time', () => {
    const tool = setup();
    const parsed = z.object(tool.schema).safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('surfaces step errors as isError text results', async () => {
    const sweep = vi.fn(async () => {
      throw new Error('boom');
    });
    const tool = setup({ stepRunners: { sweepMergedWorktrees: sweep } });
    const result = await tool.handler({ workDir: '/tmp/proj' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('pipeline_step_0_sweep failed: boom');
  });
});

describe('pipeline_step_1_validate', () => {
  it('invokes validateTask and serialises ValidateResult', async () => {
    const validate = vi.fn(async () => ({ ok: true, task: FAKE_TASK }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ validateTask: validate }),
    });
    const tool = getTool(tools, 'pipeline_step_1_validate');
    const result = await tool.handler({ taskId: 'AISDLC-100.3', workDir: '/tmp/proj' });
    expect(validate).toHaveBeenCalledWith({ taskId: 'AISDLC-100.3', workDir: '/tmp/proj' });
    expect(JSON.parse(result.content[0].text).ok).toBe(true);
  });

  it('rejects calls missing required fields', () => {
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {});
    const tool = getTool(tools, 'pipeline_step_1_validate');
    const parsed = z.object(tool.schema).safeParse({ workDir: '/tmp' });
    expect(parsed.success).toBe(false);
  });
});

describe('pipeline_step_2_compute_branch', () => {
  it('invokes computeBranchName with the supplied TaskSpec', async () => {
    const compute = vi.fn(async () => ({
      branch: 'ai-sdlc/aisdlc-100.3-phase-3',
      worktreePath: '/tmp/proj/.worktrees/aisdlc-100.3',
      slug: 'phase-3',
      taskIdLower: 'aisdlc-100.3',
    }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ computeBranchName: compute }),
    });
    const tool = getTool(tools, 'pipeline_step_2_compute_branch');
    const result = await tool.handler({
      taskId: 'AISDLC-100.3',
      task: FAKE_TASK,
      workDir: '/tmp/proj',
    });
    expect(compute).toHaveBeenCalledWith({
      taskId: 'AISDLC-100.3',
      task: FAKE_TASK,
      workDir: '/tmp/proj',
      defaultPattern: undefined,
    });
    const decoded = JSON.parse(result.content[0].text);
    expect(decoded.branch).toBe('ai-sdlc/aisdlc-100.3-phase-3');
  });

  it('rejects malformed TaskSpec (missing required keys)', () => {
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {});
    const tool = getTool(tools, 'pipeline_step_2_compute_branch');
    const parsed = z.object(tool.schema).safeParse({
      taskId: 'AISDLC-100.3',
      task: { id: 'AISDLC-100.3' }, // missing every other required field
      workDir: '/tmp/proj',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('pipeline_step_3_setup_worktree', () => {
  it('passes through to setupWorktree (incl. skipFetch)', async () => {
    const setup = vi.fn(async () => ({
      branch: 'b',
      worktreePath: '/tmp/wt',
      baseSha: 'deadbeef',
    }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ setupWorktree: setup }),
    });
    const tool = getTool(tools, 'pipeline_step_3_setup_worktree');
    await tool.handler({
      taskId: 'AISDLC-100.3',
      branch: 'b',
      worktreePath: '/tmp/wt',
      workDir: '/tmp/proj',
      skipFetch: true,
    });
    expect(setup).toHaveBeenCalledWith({
      taskId: 'AISDLC-100.3',
      branch: 'b',
      worktreePath: '/tmp/wt',
      workDir: '/tmp/proj',
      skipFetch: true,
    });
  });
});

describe('pipeline_step_4_begin_task', () => {
  it('invokes beginTask and serialises sentinel info', async () => {
    const begin = vi.fn(async () => ({
      taskId: 'AISDLC-100.3',
      worktreePath: '/tmp/wt',
      sentinelPath: '/tmp/wt/.active-task',
    }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ beginTask: begin }),
    });
    const tool = getTool(tools, 'pipeline_step_4_begin_task');
    const result = await tool.handler({
      taskId: 'AISDLC-100.3',
      worktreePath: '/tmp/wt',
      workDir: '/tmp/proj',
    });
    expect(begin).toHaveBeenCalledWith({
      taskId: 'AISDLC-100.3',
      worktreePath: '/tmp/wt',
      workDir: '/tmp/proj',
      status: undefined,
    });
    expect(JSON.parse(result.content[0].text).sentinelPath).toBe('/tmp/wt/.active-task');
  });
});

describe('pipeline_step_5_build_dev_prompt', () => {
  it('invokes buildDeveloperPrompt and returns the rendered prompt', async () => {
    const build = vi.fn(async () => ({ prompt: 'PROMPT', task: FAKE_TASK }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ buildDeveloperPrompt: build }),
    });
    const tool = getTool(tools, 'pipeline_step_5_build_dev_prompt');
    const result = await tool.handler({
      taskId: 'AISDLC-100.3',
      task: FAKE_TASK,
      branch: 'b',
      worktreePath: '/tmp/wt',
    });
    expect(JSON.parse(result.content[0].text).prompt).toBe('PROMPT');
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'AISDLC-100.3',
        branch: 'b',
        worktreePath: '/tmp/wt',
      }),
    );
  });
});

describe('pipeline_step_6_parse_dev_return', () => {
  it('forwards the developerReturn payload (string or object)', async () => {
    const parse = vi.fn(async () => ({ ok: true, developer: FAKE_DEV_RETURN }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ parseDeveloperReturn: parse }),
    });
    const tool = getTool(tools, 'pipeline_step_6_parse_dev_return');
    await tool.handler({ developerReturn: '{"summary":"x"}' });
    await tool.handler({ developerReturn: FAKE_DEV_RETURN });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse).toHaveBeenNthCalledWith(1, { developerReturn: '{"summary":"x"}' });
    expect(parse).toHaveBeenNthCalledWith(2, { developerReturn: FAKE_DEV_RETURN });
  });
});

describe('pipeline_step_7_build_review_prompts', () => {
  it('invokes buildReviewPrompts with the test-injected codex flag', async () => {
    const build = vi.fn(async () => ({
      prompts: [
        { reviewer: 'code-reviewer' as const, prompt: 'P1' },
        { reviewer: 'test-reviewer' as const, prompt: 'P2' },
        { reviewer: 'security-reviewer' as const, prompt: 'P3' },
      ],
      diff: '',
      changedFiles: [],
      harnessNote: '',
    }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ buildReviewPrompts: build }),
    });
    const tool = getTool(tools, 'pipeline_step_7_build_review_prompts');
    await tool.handler({
      taskId: 'AISDLC-100.3',
      task: FAKE_TASK,
      branch: 'b',
      worktreePath: '/tmp/wt',
      workDir: '/tmp/proj',
      codexAvailable: false,
    });
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ codexAvailable: false, taskId: 'AISDLC-100.3' }),
    );
  });
});

describe('pipeline_step_8_aggregate_verdicts', () => {
  it('invokes aggregateVerdicts and returns the gate decision', async () => {
    const agg = vi.fn(async () => FAKE_VERDICT);
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ aggregateVerdicts: agg }),
    });
    const tool = getTool(tools, 'pipeline_step_8_aggregate_verdicts');
    const result = await tool.handler({ verdicts: [], harnessNote: 'note' });
    expect(agg).toHaveBeenCalledWith({ verdicts: [], harnessNote: 'note' });
    expect(JSON.parse(result.content[0].text).decision).toBe('APPROVED');
  });
});

describe('pipeline_step_9_iterate', () => {
  it('resolves the spawner via the injected factory and forwards it to iterateReviewLoop', async () => {
    const fakeSpawner: SubagentSpawner = {
      spawn: vi.fn(),
      spawnParallel: vi.fn(),
    };
    const spawnerFactory = vi.fn(async () => fakeSpawner);

    const iterate = vi.fn(async () => ({
      finalDeveloperReturn: FAKE_DEV_RETURN,
      finalVerdict: FAKE_VERDICT,
      iterations: 1,
      needsHumanAttention: false,
    }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ iterateReviewLoop: iterate }),
      spawnerFactory,
    });
    const tool = getTool(tools, 'pipeline_step_9_iterate');
    const result = await tool.handler({
      taskId: 'AISDLC-100.3',
      worktreePath: '/tmp/wt',
      task: FAKE_TASK,
      branch: 'b',
      initialDeveloperReturn: FAKE_DEV_RETURN,
      initialVerdict: FAKE_VERDICT,
      maxIterations: 2,
    });
    expect(spawnerFactory).toHaveBeenCalledOnce();
    expect(iterate).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'AISDLC-100.3',
        spawner: fakeSpawner,
        maxIterations: 2,
      }),
    );
    expect(JSON.parse(result.content[0].text).iterations).toBe(1);
  });

  it('propagates spawner factory errors as isError', async () => {
    const spawnerFactory = vi.fn(async () => {
      throw new Error('no claude CLI on PATH');
    });
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults(),
      spawnerFactory,
    });
    const tool = getTool(tools, 'pipeline_step_9_iterate');
    const result = await tool.handler({
      taskId: 'AISDLC-100.3',
      worktreePath: '/tmp/wt',
      task: FAKE_TASK,
      branch: 'b',
      initialDeveloperReturn: FAKE_DEV_RETURN,
      initialVerdict: FAKE_VERDICT,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no claude CLI on PATH');
  });
});

describe('pipeline_step_10_finalize', () => {
  it('invokes finalizeTask and returns the FinalizeTaskResult', async () => {
    const finalize = vi.fn(async () => ({
      finalSummary: 'sum',
      acceptanceCriteriaCheck: [1, 2],
      attestationPath: '.ai-sdlc/attestations/abc.dsse.json',
      choreCommitSha: 'abc1234',
      skipped: false,
    }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ finalizeTask: finalize }),
    });
    const tool = getTool(tools, 'pipeline_step_10_finalize');
    const result = await tool.handler({
      taskId: 'AISDLC-100.3',
      workDir: '/tmp/proj',
      worktreePath: '/tmp/wt',
      task: FAKE_TASK,
      developerReturn: FAKE_DEV_RETURN,
      verdict: FAKE_VERDICT,
      iterations: 1,
      skipCommit: true,
    });
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'AISDLC-100.3', skipCommit: true }),
    );
    expect(JSON.parse(result.content[0].text).choreCommitSha).toBe('abc1234');
  });
});

describe('pipeline_step_11_push_and_pr', () => {
  it('invokes pushAndPr and returns PR url', async () => {
    const push = vi.fn(async () => ({ pushed: true, prUrl: 'https://github.com/x/y/pull/1' }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ pushAndPr: push }),
    });
    const tool = getTool(tools, 'pipeline_step_11_push_and_pr');
    const result = await tool.handler({
      taskId: 'AISDLC-100.3',
      workDir: '/tmp/proj',
      worktreePath: '/tmp/wt',
      branch: 'b',
      task: FAKE_TASK,
      developerReturn: FAKE_DEV_RETURN,
      verdict: FAKE_VERDICT,
    });
    expect(push).toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).prUrl).toBe('https://github.com/x/y/pull/1');
  });
});

describe('pipeline_step_12_sibling_prs', () => {
  it('invokes siblingPrs and returns the prs list', async () => {
    const sib = vi.fn(async () => ({
      prs: [{ repo: '/abs/sibling', branch: 'b', prUrl: 'https://github.com/x/sib/pull/2' }],
    }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ siblingPrs: sib }),
    });
    const tool = getTool(tools, 'pipeline_step_12_sibling_prs');
    const result = await tool.handler({
      taskId: 'AISDLC-100.3',
      workDir: '/tmp/proj',
      task: FAKE_TASK,
      developerReturn: FAKE_DEV_RETURN,
      mainPrUrl: 'https://github.com/x/y/pull/1',
    });
    expect(sib).toHaveBeenCalledWith(
      expect.objectContaining({ mainPrUrl: 'https://github.com/x/y/pull/1' }),
    );
    const decoded = JSON.parse(result.content[0].text);
    expect(decoded.prs).toHaveLength(1);
    expect(decoded.prs[0].prUrl).toBe('https://github.com/x/sib/pull/2');
  });
});

describe('pipeline_step_13_cleanup', () => {
  it('invokes cleanupTask and returns sentinelRemoved', async () => {
    const clean = vi.fn(async () => ({ sentinelRemoved: true, syntheticTaskFileRemoved: false }));
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {
      stepRunners: makeRunnersWithDefaults({ cleanupTask: clean }),
    });
    const tool = getTool(tools, 'pipeline_step_13_cleanup');
    const result = await tool.handler({ taskId: 'AISDLC-100.3', worktreePath: '/tmp/wt' });
    expect(clean).toHaveBeenCalledWith({ taskId: 'AISDLC-100.3', worktreePath: '/tmp/wt' });
    expect(JSON.parse(result.content[0].text).sentinelRemoved).toBe(true);
  });

  it('rejects calls missing worktreePath', () => {
    const { server, tools } = createServerStub();
    registerPipelineTools(server, {});
    const tool = getTool(tools, 'pipeline_step_13_cleanup');
    const parsed = z.object(tool.schema).safeParse({ taskId: 'AISDLC-100.3' });
    expect(parsed.success).toBe(false);
  });
});
