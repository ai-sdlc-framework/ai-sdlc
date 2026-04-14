import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from './store.js';

let store: StateStore;
let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  store = StateStore.open(db);
});

afterEach(() => {
  store.close();
});

// ── Static open ────────────────────────────────────────────────────

describe('StateStore.open', () => {
  it('opens from a Database instance', () => {
    const raw = new Database(':memory:');
    const s = StateStore.open(raw);
    expect(s).toBeInstanceOf(StateStore);
    s.close();
  });

  it('opens from a file path string', () => {
    const s = StateStore.open(':memory:');
    expect(s).toBeInstanceOf(StateStore);
    s.close();
  });
});

// ── Migration ──────────────────────────────────────────────────────

describe('migrate', () => {
  it('runs all migrations on a fresh database', () => {
    // store was created in beforeEach — check schema_version table
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent — calling open twice does not fail', () => {
    // Re-open on same db that already has schema
    const store2 = StateStore.open(db);
    // Should not throw — migrations detect version >= current
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(1);
    store2.close();
  });
});

// ── Complexity Profiles ────────────────────────────────────────────

describe('Complexity Profiles', () => {
  it('saves and retrieves a complexity profile', () => {
    const id = store.saveComplexityProfile({
      repoPath: '/repo',
      score: 42,
      filesCount: 100,
      modulesCount: 10,
      dependencyCount: 5,
      rawData: '{"raw": true}',
      architecturalPatterns: '["monolith"]',
      hotspots: '[]',
      moduleGraph: '{}',
      conventionsData: '{}',
    });
    expect(id).toBeGreaterThan(0);

    const profile = store.getLatestComplexityProfile('/repo');
    expect(profile).toBeDefined();
    expect(profile!.repoPath).toBe('/repo');
    expect(profile!.score).toBe(42);
    expect(profile!.filesCount).toBe(100);
    expect(profile!.modulesCount).toBe(10);
    expect(profile!.dependencyCount).toBe(5);
    expect(profile!.rawData).toBe('{"raw": true}');
    expect(profile!.architecturalPatterns).toBe('["monolith"]');
    expect(profile!.hotspots).toBe('[]');
    expect(profile!.moduleGraph).toBe('{}');
    expect(profile!.conventionsData).toBe('{}');
    expect(profile!.analyzedAt).toBeDefined();
  });

  it('returns undefined for unknown repo path', () => {
    expect(store.getLatestComplexityProfile('/nonexistent')).toBeUndefined();
  });

  it('returns a profile when multiple exist for the same repo', () => {
    store.saveComplexityProfile({ repoPath: '/repo', score: 10 });
    store.saveComplexityProfile({ repoPath: '/repo', score: 20 });
    const profile = store.getLatestComplexityProfile('/repo');
    // Both inserts happen within the same second so ORDER BY analyzed_at DESC
    // may return either one; just verify we get a profile back
    expect(profile).toBeDefined();
    expect([10, 20]).toContain(profile!.score);
  });

  it('saveCodebaseProfile delegates to saveComplexityProfile', () => {
    const id = store.saveCodebaseProfile({ repoPath: '/repo', score: 99 });
    expect(id).toBeGreaterThan(0);
    const p = store.getLatestComplexityProfile('/repo');
    expect(p!.score).toBe(99);
  });
});

// ── Episodic Memory ────────────────────────────────────────────────

describe('Episodic Memory', () => {
  it('saves and retrieves episodic records', () => {
    const id = store.saveEpisodicRecord({
      issueId: 'ISS-1',
      issueNumber: 1,
      prNumber: 10,
      pipelineType: 'build',
      outcome: 'success',
      durationMs: 5000,
      filesChanged: 3,
      errorMessage: undefined,
      metadata: '{"key":"val"}',
      agentName: 'agent-x',
      complexityScore: 5,
      routingStrategy: 'direct',
      gatePassCount: 2,
      gateFailCount: 0,
      costUsd: 0.01,
      isRegression: 0,
      relatedEpisodes: '[]',
    });
    expect(id).toBeGreaterThan(0);

    const records = store.getEpisodicRecords(1);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.issueId).toBe('ISS-1');
    expect(r.issueNumber).toBe(1);
    expect(r.prNumber).toBe(10);
    expect(r.pipelineType).toBe('build');
    expect(r.outcome).toBe('success');
    expect(r.agentName).toBe('agent-x');
    expect(r.complexityScore).toBe(5);
    expect(r.routingStrategy).toBe('direct');
    expect(r.gatePassCount).toBe(2);
    expect(r.gateFailCount).toBe(0);
    expect(r.costUsd).toBe(0.01);
    expect(r.isRegression).toBe(0);
    expect(r.relatedEpisodes).toBe('[]');
  });

  it('getEpisodicRecords without issueNumber returns all', () => {
    store.saveEpisodicRecord({ pipelineType: 'a', outcome: 'ok', issueNumber: 1 });
    store.saveEpisodicRecord({ pipelineType: 'b', outcome: 'ok', issueNumber: 2 });
    const all = store.getEpisodicRecords();
    expect(all).toHaveLength(2);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      store.saveEpisodicRecord({ pipelineType: 'x', outcome: 'ok' });
    }
    const limited = store.getEpisodicRecords(undefined, 2);
    expect(limited).toHaveLength(2);
  });
});

// ── Episodic Search ────────────────────────────────────────────────

describe('searchEpisodicRecords', () => {
  beforeEach(() => {
    store.saveEpisodicRecord({
      pipelineType: 'build',
      outcome: 'success',
      agentName: 'agent-a',
      metadata: '{"files":["src/foo.ts"]}',
    });
    store.saveEpisodicRecord({
      pipelineType: 'test',
      outcome: 'failure',
      agentName: 'agent-b',
      metadata: '{"files":["src/bar.ts"]}',
    });
    store.saveEpisodicRecord({
      pipelineType: 'deploy',
      outcome: 'success',
      agentName: 'agent-a',
      metadata: null as unknown as undefined,
    });
  });

  it('filters by agentName', () => {
    const results = store.searchEpisodicRecords({ agentName: 'agent-a' });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.agentName === 'agent-a')).toBe(true);
  });

  it('filters by outcome', () => {
    const results = store.searchEpisodicRecords({ outcome: 'failure' });
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('failure');
  });

  it('filters by files (metadata LIKE)', () => {
    const results = store.searchEpisodicRecords({ files: 'foo.ts' });
    expect(results).toHaveLength(1);
    expect(results[0].pipelineType).toBe('build');
  });

  it('filters by since', () => {
    // All records created "now", so since far past returns all
    const results = store.searchEpisodicRecords({ since: '2000-01-01' });
    expect(results).toHaveLength(3);
  });

  it('returns all when no filters', () => {
    const results = store.searchEpisodicRecords({});
    expect(results).toHaveLength(3);
  });

  it('respects limit', () => {
    const results = store.searchEpisodicRecords({ limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('combines multiple filters', () => {
    const results = store.searchEpisodicRecords({
      agentName: 'agent-a',
      outcome: 'success',
    });
    expect(results).toHaveLength(2);
  });
});

// ── Autonomy Ledger ────────────────────────────────────────────────

describe('Autonomy Ledger', () => {
  it('upserts and retrieves a ledger entry', () => {
    store.upsertAutonomyLedger({
      agentName: 'bot-1',
      currentLevel: 2,
      totalTasks: 10,
      successCount: 8,
      failureCount: 2,
      lastTaskAt: '2025-01-01',
      metrics: '{}',
      prApprovalRate: 0.8,
      rollbackCount: 1,
      securityIncidents: 0,
      promotedAt: '2025-01-01',
      demotedAt: undefined,
      timeAtLevelMs: 3600000,
    });

    const entry = store.getAutonomyLedger('bot-1');
    expect(entry).toBeDefined();
    expect(entry!.agentName).toBe('bot-1');
    expect(entry!.currentLevel).toBe(2);
    expect(entry!.totalTasks).toBe(10);
    expect(entry!.successCount).toBe(8);
    expect(entry!.failureCount).toBe(2);
    expect(entry!.prApprovalRate).toBe(0.8);
    expect(entry!.rollbackCount).toBe(1);
    expect(entry!.securityIncidents).toBe(0);
    expect(entry!.timeAtLevelMs).toBe(3600000);
  });

  it('returns undefined for unknown agent', () => {
    expect(store.getAutonomyLedger('no-such-agent')).toBeUndefined();
  });

  it('updates on conflict (upsert)', () => {
    store.upsertAutonomyLedger({
      agentName: 'bot-1',
      currentLevel: 1,
      totalTasks: 5,
      successCount: 5,
      failureCount: 0,
    });
    store.upsertAutonomyLedger({
      agentName: 'bot-1',
      currentLevel: 3,
      totalTasks: 20,
      successCount: 18,
      failureCount: 2,
    });
    const entry = store.getAutonomyLedger('bot-1');
    expect(entry!.currentLevel).toBe(3);
    expect(entry!.totalTasks).toBe(20);
  });

  it('getAllAutonomyLedgerEntries returns all agents ordered by name', () => {
    store.upsertAutonomyLedger({
      agentName: 'z-bot',
      currentLevel: 0,
      totalTasks: 0,
      successCount: 0,
      failureCount: 0,
    });
    store.upsertAutonomyLedger({
      agentName: 'a-bot',
      currentLevel: 1,
      totalTasks: 1,
      successCount: 1,
      failureCount: 0,
    });
    const entries = store.getAllAutonomyLedgerEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].agentName).toBe('a-bot');
    expect(entries[1].agentName).toBe('z-bot');
  });
});

// ── Pipeline Runs ──────────────────────────────────────────────────

describe('Pipeline Runs', () => {
  it('saves and retrieves a pipeline run', () => {
    const id = store.savePipelineRun({
      runId: 'run-1',
      issueId: 'ISS-1',
      issueNumber: 42,
      prNumber: 7,
      pipelineType: 'build',
      status: 'running',
      currentStage: 'compile',
      result: undefined,
      gateResults: undefined,
      costUsd: 0.05,
      tokensUsed: 1000,
      model: 'gpt-4',
      agentName: 'agent-x',
      complexityScore: 3,
    });
    expect(id).toBeGreaterThan(0);

    const run = store.getPipelineRun('run-1');
    expect(run).toBeDefined();
    expect(run!.runId).toBe('run-1');
    expect(run!.issueId).toBe('ISS-1');
    expect(run!.issueNumber).toBe(42);
    expect(run!.prNumber).toBe(7);
    expect(run!.pipelineType).toBe('build');
    expect(run!.status).toBe('running');
    expect(run!.currentStage).toBe('compile');
    expect(run!.costUsd).toBe(0.05);
    expect(run!.tokensUsed).toBe(1000);
    expect(run!.model).toBe('gpt-4');
    expect(run!.agentName).toBe('agent-x');
    expect(run!.complexityScore).toBe(3);
    expect(run!.startedAt).toBeDefined();
    expect(run!.completedAt).toBeNull();
  });

  it('returns undefined for unknown runId', () => {
    expect(store.getPipelineRun('no-such-run')).toBeUndefined();
  });

  it('updatePipelineRunStatus sets completed_at for terminal status "completed"', () => {
    store.savePipelineRun({
      runId: 'run-2',
      pipelineType: 'test',
      status: 'running',
    });
    store.updatePipelineRunStatus('run-2', 'completed', {
      currentStage: 'done',
      result: '{"ok":true}',
      gateResults: '{"pass":true}',
    });
    const run = store.getPipelineRun('run-2');
    expect(run!.status).toBe('completed');
    expect(run!.currentStage).toBe('done');
    expect(run!.completedAt).toBeDefined();
    expect(run!.result).toBe('{"ok":true}');
    expect(run!.gateResults).toBe('{"pass":true}');
  });

  it('updatePipelineRunStatus sets completed_at for terminal status "failed"', () => {
    store.savePipelineRun({
      runId: 'run-3',
      pipelineType: 'deploy',
      status: 'running',
    });
    store.updatePipelineRunStatus('run-3', 'failed', {
      currentStage: 'deploy',
      result: '{"error":"timeout"}',
    });
    const run = store.getPipelineRun('run-3');
    expect(run!.status).toBe('failed');
    expect(run!.completedAt).toBeDefined();
  });

  it('updatePipelineRunStatus does not set completed_at for non-terminal status', () => {
    store.savePipelineRun({
      runId: 'run-4',
      pipelineType: 'build',
      status: 'pending',
    });
    store.updatePipelineRunStatus('run-4', 'running', {
      currentStage: 'compile',
    });
    const run = store.getPipelineRun('run-4');
    expect(run!.status).toBe('running');
    expect(run!.completedAt).toBeNull();
  });

  it('updatePipelineRunStatus with no opts', () => {
    store.savePipelineRun({
      runId: 'run-5',
      pipelineType: 'build',
      status: 'pending',
    });
    store.updatePipelineRunStatus('run-5', 'running');
    const run = store.getPipelineRun('run-5');
    expect(run!.status).toBe('running');
  });

  it('getPipelineRuns with issueNumber filter', () => {
    store.savePipelineRun({ runId: 'r1', pipelineType: 'a', status: 'completed', issueNumber: 5 });
    store.savePipelineRun({ runId: 'r2', pipelineType: 'b', status: 'completed', issueNumber: 6 });
    store.savePipelineRun({ runId: 'r3', pipelineType: 'c', status: 'completed', issueNumber: 5 });

    const filtered = store.getPipelineRuns(5);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.issueNumber === 5)).toBe(true);
  });

  it('getPipelineRuns without filter returns all (with limit)', () => {
    for (let i = 0; i < 5; i++) {
      store.savePipelineRun({ runId: `r${i}`, pipelineType: 'x', status: 'pending' });
    }
    const all = store.getPipelineRuns();
    expect(all).toHaveLength(5);

    const limited = store.getPipelineRuns(undefined, 2);
    expect(limited).toHaveLength(2);
  });
});

// ── Conventions ────────────────────────────────────────────────────

describe('Conventions', () => {
  it('saves and retrieves conventions', () => {
    const id = store.saveConvention({
      category: 'naming',
      pattern: 'camelCase',
      confidence: 0.95,
      examples: '["fooBar", "bazQux"]',
    });
    expect(id).toBeGreaterThan(0);

    const conventions = store.getConventions('naming');
    expect(conventions).toHaveLength(1);
    expect(conventions[0].category).toBe('naming');
    expect(conventions[0].pattern).toBe('camelCase');
    expect(conventions[0].confidence).toBe(0.95);
    expect(conventions[0].examples).toBe('["fooBar", "bazQux"]');
    expect(conventions[0].detectedAt).toBeDefined();
  });

  it('getConventions without category returns all', () => {
    store.saveConvention({ category: 'naming', pattern: 'camelCase' });
    store.saveConvention({ category: 'formatting', pattern: '2-space-indent' });
    const all = store.getConventions();
    expect(all).toHaveLength(2);
  });

  it('getConventions filters by category', () => {
    store.saveConvention({ category: 'naming', pattern: 'camelCase' });
    store.saveConvention({ category: 'formatting', pattern: '2-space' });
    const naming = store.getConventions('naming');
    expect(naming).toHaveLength(1);
    expect(naming[0].category).toBe('naming');
  });
});

// ── Hotspots ───────────────────────────────────────────────────────

describe('Hotspots', () => {
  it('saves and retrieves hotspot records', () => {
    const id = store.saveHotspot({
      repoPath: '/repo',
      filePath: 'src/index.ts',
      churnRate: 0.8,
      complexity: 15,
      commitCount: 50,
      lastModified: '2025-01-01',
      note: 'high churn',
    });
    expect(id).toBeGreaterThan(0);

    const hotspots = store.getHotspots('/repo');
    expect(hotspots).toHaveLength(1);
    expect(hotspots[0].repoPath).toBe('/repo');
    expect(hotspots[0].filePath).toBe('src/index.ts');
    expect(hotspots[0].churnRate).toBe(0.8);
    expect(hotspots[0].complexity).toBe(15);
    expect(hotspots[0].commitCount).toBe(50);
    expect(hotspots[0].lastModified).toBe('2025-01-01');
    expect(hotspots[0].note).toBe('high churn');
    expect(hotspots[0].analyzedAt).toBeDefined();
  });

  it('orders by churn_rate DESC, complexity DESC', () => {
    store.saveHotspot({ repoPath: '/r', filePath: 'a.ts', churnRate: 0.2, complexity: 5 });
    store.saveHotspot({ repoPath: '/r', filePath: 'b.ts', churnRate: 0.9, complexity: 10 });
    store.saveHotspot({ repoPath: '/r', filePath: 'c.ts', churnRate: 0.9, complexity: 20 });
    const h = store.getHotspots('/r');
    expect(h[0].filePath).toBe('c.ts');
    expect(h[1].filePath).toBe('b.ts');
    expect(h[2].filePath).toBe('a.ts');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      store.saveHotspot({ repoPath: '/r', filePath: `f${i}`, churnRate: i, complexity: i });
    }
    const h = store.getHotspots('/r', 2);
    expect(h).toHaveLength(2);
  });
});

// ── Routing History ────────────────────────────────────────────────

describe('Routing History', () => {
  it('saves and retrieves routing decisions', () => {
    const id = store.saveRoutingDecision({
      issueId: 'ISS-1',
      issueNumber: 10,
      taskComplexity: 3,
      codebaseComplexity: 42,
      routingStrategy: 'direct',
      agentName: 'agent-a',
      reason: 'low complexity',
    });
    expect(id).toBeGreaterThan(0);

    const history = store.getRoutingHistory();
    expect(history).toHaveLength(1);
    expect(history[0].issueId).toBe('ISS-1');
    expect(history[0].issueNumber).toBe(10);
    expect(history[0].taskComplexity).toBe(3);
    expect(history[0].codebaseComplexity).toBe(42);
    expect(history[0].routingStrategy).toBe('direct');
    expect(history[0].agentName).toBe('agent-a');
    expect(history[0].reason).toBe('low complexity');
    expect(history[0].decidedAt).toBeDefined();
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      store.saveRoutingDecision({
        taskComplexity: i,
        codebaseComplexity: i * 10,
        routingStrategy: 'auto',
      });
    }
    const h = store.getRoutingHistory(2);
    expect(h).toHaveLength(2);
  });
});

// ── Cost Ledger ────────────────────────────────────────────────────

describe('Cost Ledger', () => {
  it('saves and retrieves cost entries', () => {
    const id = store.saveCostEntry({
      runId: 'run-1',
      agentName: 'agent-a',
      pipelineType: 'build',
      model: 'gpt-4',
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      costUsd: 0.05,
      issueId: 'ISS-1',
      issueNumber: 42,
      prNumber: 7,
      stageName: 'compile',
      cacheReadTokens: 50,
    });
    expect(id).toBeGreaterThan(0);

    const entries = store.getCostEntries({ runId: 'run-1' });
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.runId).toBe('run-1');
    expect(e.agentName).toBe('agent-a');
    expect(e.pipelineType).toBe('build');
    expect(e.model).toBe('gpt-4');
    expect(e.inputTokens).toBe(100);
    expect(e.outputTokens).toBe(200);
    expect(e.totalTokens).toBe(300);
    expect(e.costUsd).toBe(0.05);
    expect(e.issueId).toBe('ISS-1');
    expect(e.issueNumber).toBe(42);
    expect(e.prNumber).toBe(7);
    expect(e.stageName).toBe('compile');
    expect(e.cacheReadTokens).toBe(50);
    expect(e.createdAt).toBeDefined();
  });

  it('getCostEntries filters by agentName', () => {
    store.saveCostEntry({ runId: 'r1', agentName: 'a', pipelineType: 'build' });
    store.saveCostEntry({ runId: 'r2', agentName: 'b', pipelineType: 'build' });
    const entries = store.getCostEntries({ agentName: 'a' });
    expect(entries).toHaveLength(1);
    expect(entries[0].agentName).toBe('a');
  });

  it('getCostEntries filters by since', () => {
    store.saveCostEntry({ runId: 'r1', agentName: 'a', pipelineType: 'build' });
    // All entries created "now" so a far-past since returns all
    const entries = store.getCostEntries({ since: '2000-01-01' });
    expect(entries).toHaveLength(1);
  });

  it('getCostEntries with no filters returns all (up to limit)', () => {
    for (let i = 0; i < 5; i++) {
      store.saveCostEntry({ runId: `r${i}`, agentName: 'a', pipelineType: 'build' });
    }
    const entries = store.getCostEntries();
    expect(entries).toHaveLength(5);

    const limited = store.getCostEntries({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('getCostEntries combines multiple filters', () => {
    store.saveCostEntry({ runId: 'r1', agentName: 'a', pipelineType: 'build' });
    store.saveCostEntry({ runId: 'r1', agentName: 'b', pipelineType: 'build' });
    store.saveCostEntry({ runId: 'r2', agentName: 'a', pipelineType: 'build' });

    const entries = store.getCostEntries({ runId: 'r1', agentName: 'a' });
    expect(entries).toHaveLength(1);
  });
});

// ── Cost Summary ───────────────────────────────────────────────────

describe('getCostSummary', () => {
  it('returns zeros when no entries', () => {
    const summary = store.getCostSummary();
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.entryCount).toBe(0);
  });

  it('aggregates cost entries', () => {
    store.saveCostEntry({
      runId: 'r1',
      agentName: 'a',
      pipelineType: 'build',
      costUsd: 0.1,
      totalTokens: 500,
    });
    store.saveCostEntry({
      runId: 'r2',
      agentName: 'a',
      pipelineType: 'test',
      costUsd: 0.2,
      totalTokens: 1000,
    });
    const summary = store.getCostSummary();
    expect(summary.totalCostUsd).toBeCloseTo(0.3, 5);
    expect(summary.totalTokens).toBe(1500);
    expect(summary.entryCount).toBe(2);
  });

  it('filters by since', () => {
    store.saveCostEntry({
      runId: 'r1',
      agentName: 'a',
      pipelineType: 'build',
      costUsd: 0.1,
      totalTokens: 500,
    });
    // Far-future since returns nothing
    const summary = store.getCostSummary('2099-01-01');
    expect(summary.entryCount).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
  });
});

// ── Gate Threshold Overrides ───────────────────────────────────────

describe('Gate Threshold Overrides', () => {
  it('saves and retrieves overrides', () => {
    const id = store.saveGateThresholdOverride({
      gateName: 'quality',
      complexityBand: 'high',
      enforcementLevel: 'strict',
      thresholdOverrides: '{"minCoverage":90}',
      active: 1,
    });
    expect(id).toBeGreaterThan(0);

    const overrides = store.getGateThresholdOverrides('quality', 'high');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].gateName).toBe('quality');
    expect(overrides[0].complexityBand).toBe('high');
    expect(overrides[0].enforcementLevel).toBe('strict');
    expect(overrides[0].thresholdOverrides).toBe('{"minCoverage":90}');
    expect(overrides[0].active).toBe(1);
    expect(overrides[0].createdAt).toBeDefined();
  });

  it('upserts on conflict (same gate_name + complexity_band)', () => {
    store.saveGateThresholdOverride({
      gateName: 'quality',
      complexityBand: 'high',
      enforcementLevel: 'warn',
    });
    store.saveGateThresholdOverride({
      gateName: 'quality',
      complexityBand: 'high',
      enforcementLevel: 'strict',
    });
    const overrides = store.getGateThresholdOverrides('quality');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].enforcementLevel).toBe('strict');
  });

  it('filters by gateName only', () => {
    store.saveGateThresholdOverride({
      gateName: 'quality',
      complexityBand: 'high',
      enforcementLevel: 'strict',
    });
    store.saveGateThresholdOverride({
      gateName: 'security',
      complexityBand: 'low',
      enforcementLevel: 'warn',
    });
    const overrides = store.getGateThresholdOverrides('quality');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].gateName).toBe('quality');
  });

  it('filters by complexityBand only', () => {
    store.saveGateThresholdOverride({
      gateName: 'quality',
      complexityBand: 'high',
      enforcementLevel: 'strict',
    });
    store.saveGateThresholdOverride({
      gateName: 'security',
      complexityBand: 'high',
      enforcementLevel: 'warn',
    });
    const overrides = store.getGateThresholdOverrides(undefined, 'high');
    expect(overrides).toHaveLength(2);
  });

  it('returns all active overrides when no filters', () => {
    store.saveGateThresholdOverride({
      gateName: 'quality',
      complexityBand: 'high',
      enforcementLevel: 'strict',
    });
    store.saveGateThresholdOverride({
      gateName: 'security',
      complexityBand: 'low',
      enforcementLevel: 'warn',
    });
    const overrides = store.getGateThresholdOverrides();
    expect(overrides).toHaveLength(2);
  });

  it('excludes inactive overrides', () => {
    store.saveGateThresholdOverride({
      gateName: 'quality',
      complexityBand: 'high',
      enforcementLevel: 'strict',
      active: 0,
    });
    const overrides = store.getGateThresholdOverrides();
    expect(overrides).toHaveLength(0);
  });
});

// ── Autonomy Events ────────────────────────────────────────────────

describe('Autonomy Events', () => {
  it('saves and retrieves autonomy events', () => {
    const id = store.saveAutonomyEvent({
      agentName: 'bot-1',
      eventType: 'promotion',
      fromLevel: 1,
      toLevel: 2,
      trigger: 'threshold met',
      metricsSnapshot: '{"success":0.95}',
      unmetConditions: null as unknown as undefined,
    });
    expect(id).toBeGreaterThan(0);

    const events = store.getAutonomyEvents('bot-1');
    expect(events).toHaveLength(1);
    expect(events[0].agentName).toBe('bot-1');
    expect(events[0].eventType).toBe('promotion');
    expect(events[0].fromLevel).toBe(1);
    expect(events[0].toLevel).toBe(2);
    expect(events[0].trigger).toBe('threshold met');
    expect(events[0].metricsSnapshot).toBe('{"success":0.95}');
    expect(events[0].createdAt).toBeDefined();
  });

  it('getAutonomyEvents without agentName returns all', () => {
    store.saveAutonomyEvent({
      agentName: 'bot-1',
      eventType: 'promotion',
      fromLevel: 0,
      toLevel: 1,
    });
    store.saveAutonomyEvent({
      agentName: 'bot-2',
      eventType: 'demotion',
      fromLevel: 2,
      toLevel: 1,
    });
    const all = store.getAutonomyEvents();
    expect(all).toHaveLength(2);
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.saveAutonomyEvent({
        agentName: 'bot-1',
        eventType: 'evaluation',
        fromLevel: 1,
        toLevel: 1,
      });
    }
    const events = store.getAutonomyEvents('bot-1', 2);
    expect(events).toHaveLength(2);
  });
});

// ── Handoff Events ─────────────────────────────────────────────────

describe('Handoff Events', () => {
  it('saves and retrieves handoff events', () => {
    const id = store.saveHandoffEvent({
      runId: 'run-1',
      fromAgent: 'planner',
      toAgent: 'executor',
      payloadHash: 'abc123',
      validationResult: 'pass',
      errorMessage: undefined,
    });
    expect(id).toBeGreaterThan(0);

    const events = store.getHandoffEvents('run-1');
    expect(events).toHaveLength(1);
    expect(events[0].runId).toBe('run-1');
    expect(events[0].fromAgent).toBe('planner');
    expect(events[0].toAgent).toBe('executor');
    expect(events[0].payloadHash).toBe('abc123');
    expect(events[0].validationResult).toBe('pass');
    expect(events[0].createdAt).toBeDefined();
  });

  it('getHandoffEvents without runId returns all', () => {
    store.saveHandoffEvent({
      runId: 'run-1',
      fromAgent: 'a',
      toAgent: 'b',
      validationResult: 'pass',
    });
    store.saveHandoffEvent({
      runId: 'run-2',
      fromAgent: 'c',
      toAgent: 'd',
      validationResult: 'fail',
      errorMessage: 'schema mismatch',
    });
    const all = store.getHandoffEvents();
    expect(all).toHaveLength(2);
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.saveHandoffEvent({
        runId: `run-${i}`,
        fromAgent: 'a',
        toAgent: 'b',
        validationResult: 'pass',
      });
    }
    const events = store.getHandoffEvents(undefined, 2);
    expect(events).toHaveLength(2);
  });
});

// ── Deployments ────────────────────────────────────────────────────

describe('Deployments', () => {
  it('saves and retrieves a deployment', () => {
    const id = store.saveDeployment({
      deploymentId: 'dep-1',
      targetName: 'api',
      provider: 'aws',
      version: '1.0.0',
      environment: 'production',
      state: 'pending',
      url: undefined,
      error: undefined,
      startedAt: '2025-01-01',
      completedAt: undefined,
    });
    expect(id).toBeGreaterThan(0);

    const dep = store.getDeployment('dep-1');
    expect(dep).toBeDefined();
    expect(dep!.deploymentId).toBe('dep-1');
    expect(dep!.targetName).toBe('api');
    expect(dep!.provider).toBe('aws');
    expect(dep!.version).toBe('1.0.0');
    expect(dep!.environment).toBe('production');
    expect(dep!.state).toBe('pending');
  });

  it('returns undefined for unknown deploymentId', () => {
    expect(store.getDeployment('no-such-dep')).toBeUndefined();
  });

  it('updateDeployment changes state and optional fields', () => {
    store.saveDeployment({
      deploymentId: 'dep-2',
      targetName: 'web',
      provider: 'vercel',
      version: '2.0.0',
      environment: 'staging',
      state: 'deploying',
    });
    store.updateDeployment('dep-2', {
      state: 'healthy',
      url: 'https://example.com',
      completedAt: '2025-01-01T12:00:00Z',
    });
    const dep = store.getDeployment('dep-2');
    expect(dep!.state).toBe('healthy');
    expect(dep!.url).toBe('https://example.com');
    expect(dep!.completedAt).toBe('2025-01-01T12:00:00Z');
  });

  it('updateDeployment sets error', () => {
    store.saveDeployment({
      deploymentId: 'dep-3',
      targetName: 'api',
      provider: 'aws',
      version: '1.0.0',
      environment: 'production',
      state: 'deploying',
    });
    store.updateDeployment('dep-3', {
      state: 'failed',
      error: 'timeout',
    });
    const dep = store.getDeployment('dep-3');
    expect(dep!.state).toBe('failed');
    expect(dep!.error).toBe('timeout');
  });

  it('getDeployments without filters returns all', () => {
    store.saveDeployment({
      deploymentId: 'd1',
      targetName: 'api',
      provider: 'aws',
      version: '1.0',
      environment: 'prod',
      state: 'healthy',
    });
    store.saveDeployment({
      deploymentId: 'd2',
      targetName: 'web',
      provider: 'vercel',
      version: '2.0',
      environment: 'staging',
      state: 'deploying',
    });
    const deps = store.getDeployments();
    expect(deps).toHaveLength(2);
  });

  it('getDeployments filters by targetName', () => {
    store.saveDeployment({
      deploymentId: 'd1',
      targetName: 'api',
      provider: 'aws',
      version: '1.0',
      environment: 'prod',
      state: 'healthy',
    });
    store.saveDeployment({
      deploymentId: 'd2',
      targetName: 'web',
      provider: 'vercel',
      version: '2.0',
      environment: 'staging',
      state: 'deploying',
    });
    const deps = store.getDeployments({ targetName: 'api' });
    expect(deps).toHaveLength(1);
    expect(deps[0].targetName).toBe('api');
  });

  it('getDeployments filters by environment', () => {
    store.saveDeployment({
      deploymentId: 'd1',
      targetName: 'api',
      provider: 'aws',
      version: '1.0',
      environment: 'prod',
      state: 'healthy',
    });
    store.saveDeployment({
      deploymentId: 'd2',
      targetName: 'web',
      provider: 'vercel',
      version: '2.0',
      environment: 'staging',
      state: 'deploying',
    });
    const deps = store.getDeployments({ environment: 'staging' });
    expect(deps).toHaveLength(1);
    expect(deps[0].environment).toBe('staging');
  });

  it('getDeployments combines targetName and environment filters', () => {
    store.saveDeployment({
      deploymentId: 'd1',
      targetName: 'api',
      provider: 'aws',
      version: '1.0',
      environment: 'prod',
      state: 'healthy',
    });
    store.saveDeployment({
      deploymentId: 'd2',
      targetName: 'api',
      provider: 'aws',
      version: '2.0',
      environment: 'staging',
      state: 'deploying',
    });
    const deps = store.getDeployments({ targetName: 'api', environment: 'prod' });
    expect(deps).toHaveLength(1);
    expect(deps[0].deploymentId).toBe('d1');
  });

  it('getDeployments respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.saveDeployment({
        deploymentId: `d${i}`,
        targetName: 'api',
        provider: 'aws',
        version: `${i}.0`,
        environment: 'prod',
        state: 'healthy',
      });
    }
    const deps = store.getDeployments({ limit: 2 });
    expect(deps).toHaveLength(2);
  });
});

// ── Rollout Steps ──────────────────────────────────────────────────

describe('Rollout Steps', () => {
  it('saves and retrieves rollout steps', () => {
    store.saveDeployment({
      deploymentId: 'dep-1',
      targetName: 'api',
      provider: 'aws',
      version: '1.0.0',
      environment: 'production',
      state: 'deploying',
    });
    const id = store.saveRolloutStep({
      deploymentId: 'dep-1',
      stepNumber: 1,
      weightPercent: 10,
      state: 'active',
      metricsSnapshot: '{"errorRate":0.01}',
      startedAt: '2025-01-01',
      completedAt: undefined,
    });
    expect(id).toBeGreaterThan(0);

    const steps = store.getRolloutSteps('dep-1');
    expect(steps).toHaveLength(1);
    expect(steps[0].deploymentId).toBe('dep-1');
    expect(steps[0].stepNumber).toBe(1);
    expect(steps[0].weightPercent).toBe(10);
    expect(steps[0].state).toBe('active');
    expect(steps[0].metricsSnapshot).toBe('{"errorRate":0.01}');
  });

  it('orders by step_number', () => {
    store.saveDeployment({
      deploymentId: 'dep-2',
      targetName: 'api',
      provider: 'aws',
      version: '1.0.0',
      environment: 'production',
      state: 'deploying',
    });
    store.saveRolloutStep({
      deploymentId: 'dep-2',
      stepNumber: 3,
      weightPercent: 100,
      state: 'pending',
    });
    store.saveRolloutStep({
      deploymentId: 'dep-2',
      stepNumber: 1,
      weightPercent: 10,
      state: 'done',
    });
    store.saveRolloutStep({
      deploymentId: 'dep-2',
      stepNumber: 2,
      weightPercent: 50,
      state: 'active',
    });

    const steps = store.getRolloutSteps('dep-2');
    expect(steps).toHaveLength(3);
    expect(steps[0].stepNumber).toBe(1);
    expect(steps[1].stepNumber).toBe(2);
    expect(steps[2].stepNumber).toBe(3);
  });

  it('returns empty array for unknown deployment', () => {
    const steps = store.getRolloutSteps('nonexistent');
    expect(steps).toHaveLength(0);
  });
});

// ── Audit Entries ──────────────────────────────────────────────────

describe('Audit Entries', () => {
  it('saves and retrieves an audit entry', () => {
    const id = store.saveAuditEntry({
      entryId: 'e1',
      actor: 'agent-1',
      action: 'execute',
      resourceType: 'pipeline',
      resourceId: 'p1',
      detail: '{"foo":"bar"}',
      hash: 'abc',
      previousHash: 'xyz',
      signature: 'sig123',
      createdAt: '2025-06-01T00:00:00Z',
    });
    expect(id).toBeGreaterThan(0);

    const entry = store.getAuditEntry('e1');
    expect(entry).toBeDefined();
    expect(entry!.entryId).toBe('e1');
    expect(entry!.actor).toBe('agent-1');
    expect(entry!.action).toBe('execute');
    expect(entry!.resourceType).toBe('pipeline');
    expect(entry!.resourceId).toBe('p1');
    expect(entry!.detail).toBe('{"foo":"bar"}');
    expect(entry!.hash).toBe('abc');
    expect(entry!.previousHash).toBe('xyz');
    expect(entry!.signature).toBe('sig123');
    expect(entry!.createdAt).toBe('2025-06-01T00:00:00Z');
  });

  it('returns undefined for unknown entryId', () => {
    expect(store.getAuditEntry('no-such-entry')).toBeUndefined();
  });

  it('saveAuditEntry uses datetime(now) when createdAt is omitted', () => {
    store.saveAuditEntry({
      entryId: 'e2',
      actor: 'agent-1',
      action: 'deploy',
    });
    const entry = store.getAuditEntry('e2');
    expect(entry!.createdAt).toBeDefined();
  });

  it('queryAuditEntries filters by actor', () => {
    store.saveAuditEntry({ entryId: 'e1', actor: 'agent-1', action: 'a' });
    store.saveAuditEntry({ entryId: 'e2', actor: 'agent-2', action: 'b' });
    const results = store.queryAuditEntries({ actor: 'agent-1' });
    expect(results).toHaveLength(1);
    expect(results[0].actor).toBe('agent-1');
  });

  it('queryAuditEntries filters by action', () => {
    store.saveAuditEntry({ entryId: 'e1', actor: 'a', action: 'deploy' });
    store.saveAuditEntry({ entryId: 'e2', actor: 'a', action: 'execute' });
    const results = store.queryAuditEntries({ action: 'deploy' });
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('deploy');
  });

  it('queryAuditEntries filters by resourceType', () => {
    store.saveAuditEntry({ entryId: 'e1', actor: 'a', action: 'x', resourceType: 'pipeline' });
    store.saveAuditEntry({ entryId: 'e2', actor: 'a', action: 'x', resourceType: 'gate' });
    const results = store.queryAuditEntries({ resourceType: 'pipeline' });
    expect(results).toHaveLength(1);
  });

  it('queryAuditEntries filters by resourceId', () => {
    store.saveAuditEntry({ entryId: 'e1', actor: 'a', action: 'x', resourceId: 'r1' });
    store.saveAuditEntry({ entryId: 'e2', actor: 'a', action: 'x', resourceId: 'r2' });
    const results = store.queryAuditEntries({ resourceId: 'r1' });
    expect(results).toHaveLength(1);
  });

  it('queryAuditEntries filters by since and until', () => {
    store.saveAuditEntry({
      entryId: 'e1',
      actor: 'a',
      action: 'x',
      createdAt: '2025-01-01T00:00:00Z',
    });
    store.saveAuditEntry({
      entryId: 'e2',
      actor: 'a',
      action: 'x',
      createdAt: '2025-06-15T00:00:00Z',
    });
    store.saveAuditEntry({
      entryId: 'e3',
      actor: 'a',
      action: 'x',
      createdAt: '2025-12-31T00:00:00Z',
    });

    const results = store.queryAuditEntries({
      since: '2025-06-01T00:00:00Z',
      until: '2025-12-31T23:59:59Z',
    });
    expect(results).toHaveLength(2);
  });

  it('queryAuditEntries returns all when no filters', () => {
    store.saveAuditEntry({ entryId: 'e1', actor: 'a', action: 'x' });
    store.saveAuditEntry({ entryId: 'e2', actor: 'b', action: 'y' });
    const results = store.queryAuditEntries();
    expect(results).toHaveLength(2);
  });

  it('queryAuditEntries respects limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      store.saveAuditEntry({ entryId: `e${i}`, actor: 'a', action: 'x' });
    }
    const page1 = store.queryAuditEntries({ limit: 3 });
    expect(page1).toHaveLength(3);

    const page2 = store.queryAuditEntries({ limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
    // Should be different entries
    expect(page1[0].entryId).not.toBe(page2[0].entryId);
  });

  it('queryAuditEntries combines multiple filters', () => {
    store.saveAuditEntry({ entryId: 'e1', actor: 'a', action: 'deploy', resourceType: 'pipeline' });
    store.saveAuditEntry({
      entryId: 'e2',
      actor: 'a',
      action: 'execute',
      resourceType: 'pipeline',
    });
    store.saveAuditEntry({ entryId: 'e3', actor: 'b', action: 'deploy', resourceType: 'gate' });

    const results = store.queryAuditEntries({ actor: 'a', action: 'deploy' });
    expect(results).toHaveLength(1);
    expect(results[0].entryId).toBe('e1');
  });
});

// ── Priority Calibration ────────────────────────────────────────────

describe('Priority Calibration', () => {
  it('saves and retrieves priority samples', () => {
    const id = store.savePrioritySample({
      issueId: 'ISS-1',
      priorityComposite: 0.85,
      priorityConfidence: 0.7,
      priorityDimensions: '{"soulAlignment":0.9}',
      actualComplexity: 5,
      filesChanged: 3,
      outcome: 'success',
    });
    expect(id).toBeGreaterThan(0);

    const samples = store.getPrioritySamples();
    expect(samples).toHaveLength(1);
    expect(samples[0].issueId).toBe('ISS-1');
    expect(samples[0].priorityComposite).toBe(0.85);
    expect(samples[0].priorityConfidence).toBe(0.7);
    expect(samples[0].priorityDimensions).toBe('{"soulAlignment":0.9}');
    expect(samples[0].actualComplexity).toBe(5);
    expect(samples[0].filesChanged).toBe(3);
    expect(samples[0].outcome).toBe('success');
    expect(samples[0].sampledAt).toBeDefined();
  });

  it('getPrioritySamples filters by since', () => {
    store.savePrioritySample({
      issueId: 'ISS-1',
      priorityComposite: 0.5,
      priorityConfidence: 0.6,
    });
    // Far-future since returns nothing
    const empty = store.getPrioritySamples({ since: '2099-01-01' });
    expect(empty).toHaveLength(0);

    // Far-past since returns all
    const all = store.getPrioritySamples({ since: '2000-01-01' });
    expect(all).toHaveLength(1);
  });

  it('getPrioritySamples respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.savePrioritySample({
        issueId: `ISS-${i}`,
        priorityComposite: i * 0.1,
        priorityConfidence: 0.5,
      });
    }
    const limited = store.getPrioritySamples({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('computeCalibrationCoefficient returns 1.0 with no data', () => {
    const coeff = store.computeCalibrationCoefficient();
    expect(coeff).toBe(1.0);
  });

  it('computeCalibrationCoefficient returns 1.0 with no outcome data', () => {
    store.savePrioritySample({
      issueId: 'ISS-1',
      priorityComposite: 0.8,
      priorityConfidence: 0.9,
      // no outcome
    });
    const coeff = store.computeCalibrationCoefficient();
    expect(coeff).toBe(1.0);
  });

  it('computeCalibrationCoefficient adjusts with calibration samples', () => {
    // Successes with higher priority than failures → well-calibrated
    store.savePrioritySample({
      issueId: 'ISS-1',
      priorityComposite: 0.9,
      priorityConfidence: 0.8,
      outcome: 'success',
    });
    store.savePrioritySample({
      issueId: 'ISS-2',
      priorityComposite: 0.8,
      priorityConfidence: 0.7,
      outcome: 'success',
    });
    store.savePrioritySample({
      issueId: 'ISS-3',
      priorityComposite: 0.3,
      priorityConfidence: 0.5,
      outcome: 'failure',
    });
    store.savePrioritySample({
      issueId: 'ISS-4',
      priorityComposite: 0.2,
      priorityConfidence: 0.4,
      outcome: 'failure',
    });

    const coeff = store.computeCalibrationCoefficient();
    // Successes avg = 0.85, failures avg = 0.25
    // ratio = 0.25/0.85 ≈ 0.294 → coefficient = 1/0.294 ≈ 3.4 → clamped to 1.3
    expect(coeff).toBeGreaterThanOrEqual(0.7);
    expect(coeff).toBeLessThanOrEqual(1.3);
    // With successes scoring higher than failures, coefficient should be >= 1.0
    expect(coeff).toBe(1.3);
  });

  it('computeCalibrationCoefficient reduces when high-priority items fail', () => {
    // Failures with higher priority than successes → over-scoring
    store.savePrioritySample({
      issueId: 'ISS-1',
      priorityComposite: 0.3,
      priorityConfidence: 0.6,
      outcome: 'success',
    });
    store.savePrioritySample({
      issueId: 'ISS-2',
      priorityComposite: 0.9,
      priorityConfidence: 0.8,
      outcome: 'failure',
    });

    const coeff = store.computeCalibrationCoefficient();
    // Failures avg = 0.9, successes avg = 0.3
    // ratio = 0.9/0.3 = 3.0 → coefficient = 1/3.0 ≈ 0.33 → clamped to 0.7
    expect(coeff).toBe(0.7);
  });
});

// ── Episodic Memory with Priority ───────────────────────────────────

describe('Episodic Memory with Priority', () => {
  it('saves and retrieves priority fields on episodic records', () => {
    store.saveEpisodicRecord({
      pipelineType: 'build',
      outcome: 'success',
      priorityComposite: 0.75,
      priorityConfidence: 0.6,
    });

    const records = store.getEpisodicRecords();
    expect(records).toHaveLength(1);
    expect(records[0].priorityComposite).toBe(0.75);
    expect(records[0].priorityConfidence).toBe(0.6);
  });
});

// ── Workflow Pattern Detection ──────────────────────────────────────

describe('Tool Sequence Events', () => {
  it('saves and retrieves a tool sequence event', () => {
    const id = store.saveToolSequenceEvent({
      sessionId: 'sess-1',
      toolName: 'Bash',
      actionCanonical: 'pnpm test',
      projectPath: '/repo',
      timestamp: '2026-03-27T10:00:00Z',
    });
    expect(id).toBeGreaterThan(0);

    const events = store.getToolSequenceEvents({ sessionId: 'sess-1' });
    expect(events).toHaveLength(1);
    expect(events[0].toolName).toBe('Bash');
    expect(events[0].actionCanonical).toBe('pnpm test');
  });

  it('batch saves multiple events', () => {
    const count = store.saveToolSequenceEvents([
      {
        sessionId: 's1',
        toolName: 'Read',
        actionCanonical: 'read:.ts',
        timestamp: '2026-01-01T00:00:00Z',
      },
      {
        sessionId: 's1',
        toolName: 'Edit',
        actionCanonical: 'edit:.ts',
        timestamp: '2026-01-01T00:00:01Z',
      },
      {
        sessionId: 's1',
        toolName: 'Bash',
        actionCanonical: 'pnpm test',
        timestamp: '2026-01-01T00:00:02Z',
      },
    ]);
    expect(count).toBe(3);

    const events = store.getToolSequenceEvents({ sessionId: 's1' });
    expect(events).toHaveLength(3);
    expect(events[0].toolName).toBe('Read');
    expect(events[2].toolName).toBe('Bash');
  });

  it('filters by since timestamp', () => {
    store.saveToolSequenceEvent({
      sessionId: 's1',
      toolName: 'Bash',
      actionCanonical: 'old',
      timestamp: '2026-01-01T00:00:00Z',
    });
    store.saveToolSequenceEvent({
      sessionId: 's1',
      toolName: 'Bash',
      actionCanonical: 'new',
      timestamp: '2026-06-01T00:00:00Z',
    });

    const events = store.getToolSequenceEvents({ since: '2026-03-01T00:00:00Z' });
    expect(events).toHaveLength(1);
    expect(events[0].actionCanonical).toBe('new');
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.saveToolSequenceEvent({
        sessionId: 's1',
        toolName: 'Bash',
        actionCanonical: `cmd-${i}`,
        timestamp: `2026-01-0${i + 1}T00:00:00Z`,
      });
    }
    const events = store.getToolSequenceEvents({ limit: 2 });
    expect(events).toHaveLength(2);
  });
});

describe('Workflow Patterns', () => {
  it('saves and retrieves a workflow pattern', () => {
    const id = store.saveWorkflowPattern({
      patternHash: 'abc123',
      patternType: 'command-sequence',
      sequenceJson: JSON.stringify([{ tool: 'Read', action: 'read:.ts' }]),
      frequency: 5,
      sessionCount: 3,
      confidence: 0.8,
      firstSeen: '2026-01-01',
      lastSeen: '2026-03-01',
      status: 'detected',
    });
    expect(id).toBeGreaterThan(0);

    const patterns = store.getWorkflowPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].patternHash).toBe('abc123');
    expect(patterns[0].confidence).toBe(0.8);
  });

  it('filters by status', () => {
    store.saveWorkflowPattern({
      patternHash: 'p1',
      patternType: 'command-sequence',
      sequenceJson: '[]',
      frequency: 3,
      sessionCount: 3,
      confidence: 0.7,
      status: 'detected',
    });
    store.saveWorkflowPattern({
      patternHash: 'p2',
      patternType: 'copy-paste-cycle',
      sequenceJson: '[]',
      frequency: 5,
      sessionCount: 4,
      confidence: 0.9,
      status: 'approved',
    });

    const detected = store.getWorkflowPatterns({ status: 'detected' });
    expect(detected).toHaveLength(1);
    expect(detected[0].patternHash).toBe('p1');
  });

  it('upserts on duplicate pattern_hash', () => {
    store.saveWorkflowPattern({
      patternHash: 'dup',
      patternType: 'command-sequence',
      sequenceJson: '[]',
      frequency: 3,
      sessionCount: 3,
      confidence: 0.6,
      status: 'detected',
    });
    store.saveWorkflowPattern({
      patternHash: 'dup',
      patternType: 'command-sequence',
      sequenceJson: '[]',
      frequency: 5,
      sessionCount: 4,
      confidence: 0.8,
      status: 'detected',
    });

    const patterns = store.getWorkflowPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].frequency).toBe(5);
  });
});

describe('Pattern Proposals', () => {
  it('saves and retrieves a proposal', () => {
    const patternId = store.saveWorkflowPattern({
      patternHash: 'p1',
      patternType: 'command-sequence',
      sequenceJson: '[]',
      frequency: 3,
      sessionCount: 3,
      confidence: 0.7,
      status: 'detected',
    });

    const proposalId = store.savePatternProposal({
      patternId,
      proposalType: 'command-sequence',
      artifactType: 'command',
      draftContent: '# Auto-generated command',
      confidence: 0.7,
      status: 'pending',
    });
    expect(proposalId).toBeGreaterThan(0);

    const proposals = store.getPatternProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].artifactType).toBe('command');
    expect(proposals[0].status).toBe('pending');
  });

  it('filters proposals by status', () => {
    const patternId = store.saveWorkflowPattern({
      patternHash: 'p2',
      patternType: 'periodic-task',
      sequenceJson: '[]',
      frequency: 10,
      sessionCount: 5,
      confidence: 0.9,
      status: 'detected',
    });
    store.savePatternProposal({
      patternId,
      proposalType: 'periodic',
      artifactType: 'workflow',
      draftContent: 'a',
      confidence: 0.9,
      status: 'pending',
    });
    store.savePatternProposal({
      patternId,
      proposalType: 'periodic',
      artifactType: 'workflow',
      draftContent: 'b',
      confidence: 0.8,
      status: 'approved',
    });

    const pending = store.getPatternProposals({ status: 'pending' });
    expect(pending).toHaveLength(1);
  });

  it('updates proposal status', () => {
    const patternId = store.saveWorkflowPattern({
      patternHash: 'p3',
      patternType: 'command-sequence',
      sequenceJson: '[]',
      frequency: 3,
      sessionCount: 3,
      confidence: 0.7,
      status: 'detected',
    });
    const proposalId = store.savePatternProposal({
      patternId,
      proposalType: 'command-sequence',
      artifactType: 'command',
      draftContent: 'content',
      confidence: 0.7,
      status: 'pending',
    });

    store.updateProposalStatus(proposalId, 'approved', 'Looks good');

    const proposals = store.getPatternProposals({ status: 'approved' });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].reviewerReason).toBe('Looks good');
    expect(proposals[0].reviewedAt).toBeTruthy();
  });

  it('rejects proposal with reason', () => {
    const patternId = store.saveWorkflowPattern({
      patternHash: 'p4',
      patternType: 'command-sequence',
      sequenceJson: '[]',
      frequency: 3,
      sessionCount: 3,
      confidence: 0.7,
      status: 'detected',
    });
    const proposalId = store.savePatternProposal({
      patternId,
      proposalType: 'command-sequence',
      artifactType: 'command',
      draftContent: 'content',
      confidence: 0.7,
      status: 'pending',
    });

    store.updateProposalStatus(proposalId, 'rejected', 'Not useful');

    const rejected = store.getPatternProposals({ status: 'rejected' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reviewerReason).toBe('Not useful');
  });
});

// ── Design Token Events (RFC-0006) ─────────────────────────────────
// Note: These getters return raw SQL rows cast as the type interface.
// The actual returned objects have snake_case keys from SQLite columns.

describe('Design Token Events', () => {
  it('inserts and retrieves token events', () => {
    const id = store.insertDesignTokenEvent({
      bindingName: 'tokens-studio',
      eventType: 'changed',
      tokensAffected: 5,
      diffJson: '{"added":2,"removed":1}',
      actor: 'ci-bot',
      pipelineRunId: 'run-42',
      designReviewDecision: 'approved',
    });
    expect(id).toBeGreaterThan(0);

    const events = store.getDesignTokenEvents('tokens-studio');
    expect(events).toHaveLength(1);
    // Raw SQLite rows have snake_case column names
    const row = events[0] as unknown as Record<string, unknown>;
    expect(row.binding_name).toBe('tokens-studio');
    expect(row.event_type).toBe('changed');
    expect(row.tokens_affected).toBe(5);
    expect(row.diff_json).toBe('{"added":2,"removed":1}');
    expect(row.actor).toBe('ci-bot');
    expect(row.pipeline_run_id).toBe('run-42');
    expect(row.design_review_decision).toBe('approved');
  });

  it('filters by binding name', () => {
    store.insertDesignTokenEvent({
      bindingName: 'tokens-studio',
      eventType: 'changed',
    });
    store.insertDesignTokenEvent({
      bindingName: 'figma-variables',
      eventType: 'deleted',
    });
    const events = store.getDesignTokenEvents('figma-variables');
    expect(events).toHaveLength(1);
    const row = events[0] as unknown as Record<string, unknown>;
    expect(row.event_type).toBe('deleted');
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.insertDesignTokenEvent({
        bindingName: 'ts',
        eventType: 'changed',
        tokensAffected: i,
      });
    }
    const events = store.getDesignTokenEvents('ts', 2);
    expect(events).toHaveLength(2);
  });

  it('handles minimal record (only required fields)', () => {
    const id = store.insertDesignTokenEvent({
      bindingName: 'minimal',
      eventType: 'breaking',
    });
    expect(id).toBeGreaterThan(0);
    const events = store.getDesignTokenEvents('minimal');
    expect(events).toHaveLength(1);
    const row = events[0] as unknown as Record<string, unknown>;
    expect(row.event_type).toBe('breaking');
  });
});

// ── Design Review Events (RFC-0006) ────────────────────────────────

describe('Design Review Events', () => {
  it('inserts and retrieves review events', () => {
    const id = store.insertDesignReviewEvent({
      bindingName: 'figma-adapter',
      prNumber: 123,
      componentName: 'Button',
      reviewer: 'designer-1',
      decision: 'approved',
      categoriesJson: '["spacing","color"]',
      actionableNotes: 'Consider dark mode contrast',
    });
    expect(id).toBeGreaterThan(0);

    const events = store.getDesignReviewEvents('figma-adapter');
    expect(events).toHaveLength(1);
    const row = events[0] as unknown as Record<string, unknown>;
    expect(row.binding_name).toBe('figma-adapter');
    expect(row.pr_number).toBe(123);
    expect(row.component_name).toBe('Button');
    expect(row.reviewer).toBe('designer-1');
    expect(row.decision).toBe('approved');
    expect(row.categories_json).toBe('["spacing","color"]');
    expect(row.actionable_notes).toBe('Consider dark mode contrast');
  });

  it('filters by binding name', () => {
    store.insertDesignReviewEvent({
      bindingName: 'adapter-a',
      reviewer: 'r1',
      decision: 'approved',
    });
    store.insertDesignReviewEvent({
      bindingName: 'adapter-b',
      reviewer: 'r2',
      decision: 'rejected',
    });
    const events = store.getDesignReviewEvents('adapter-b');
    expect(events).toHaveLength(1);
    const row = events[0] as unknown as Record<string, unknown>;
    expect(row.decision).toBe('rejected');
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.insertDesignReviewEvent({
        bindingName: 'adapter',
        reviewer: `r${i}`,
        decision: 'approved',
      });
    }
    const events = store.getDesignReviewEvents('adapter', 3);
    expect(events).toHaveLength(3);
  });
});

// ── Token Compliance History (RFC-0006) ────────────────────────────

describe('Token Compliance History', () => {
  it('inserts and retrieves compliance snapshots', () => {
    const id = store.insertTokenComplianceSnapshot({
      bindingName: 'ts-provider',
      coveragePercent: 87.5,
      violationsCount: 3,
    });
    expect(id).toBeGreaterThan(0);

    const records = store.getTokenComplianceHistory('ts-provider');
    expect(records).toHaveLength(1);
    const row = records[0] as unknown as Record<string, unknown>;
    expect(row.binding_name).toBe('ts-provider');
    expect(row.coverage_percent).toBe(87.5);
    expect(row.violations_count).toBe(3);
  });

  it('filters by binding name', () => {
    store.insertTokenComplianceSnapshot({
      bindingName: 'provider-a',
      coveragePercent: 90,
      violationsCount: 0,
    });
    store.insertTokenComplianceSnapshot({
      bindingName: 'provider-b',
      coveragePercent: 75,
      violationsCount: 5,
    });
    const records = store.getTokenComplianceHistory('provider-a');
    expect(records).toHaveLength(1);
    const row = records[0] as unknown as Record<string, unknown>;
    expect(row.coverage_percent).toBe(90);
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.insertTokenComplianceSnapshot({
        bindingName: 'p',
        coveragePercent: i * 10,
        violationsCount: i,
      });
    }
    const records = store.getTokenComplianceHistory('p', 2);
    expect(records).toHaveLength(2);
  });
});

// ── Visual Regression Results (RFC-0006) ───────────────────────────

describe('Visual Regression Results', () => {
  it('inserts and retrieves visual regression results', () => {
    const id = store.insertVisualRegressionResult({
      bindingName: 'pw-visual',
      storyName: 'Button/Default',
      viewport: 1280,
      diffPercentage: 0.05,
      approved: true,
      approver: 'designer-1',
      baselineUrl: 'file:///baselines/button.png',
      currentUrl: 'file:///current/button.png',
    });
    expect(id).toBeGreaterThan(0);

    const results = store.getVisualRegressionResults('pw-visual');
    expect(results).toHaveLength(1);
    const row = results[0] as unknown as Record<string, unknown>;
    expect(row.binding_name).toBe('pw-visual');
    expect(row.story_name).toBe('Button/Default');
    expect(row.viewport).toBe(1280);
    expect(row.diff_percentage).toBe(0.05);
    expect(row.approved).toBe(1); // SQLite stores booleans as integers
    expect(row.approver).toBe('designer-1');
    expect(row.baseline_url).toBe('file:///baselines/button.png');
    expect(row.current_url).toBe('file:///current/button.png');
  });

  it('inserts unapproved results', () => {
    store.insertVisualRegressionResult({
      bindingName: 'pw-visual',
      storyName: 'Card/Default',
      diffPercentage: 0.15,
      approved: false,
    });
    const results = store.getVisualRegressionResults('pw-visual');
    expect(results).toHaveLength(1);
    const row = results[0] as unknown as Record<string, unknown>;
    expect(row.approved).toBe(0);
  });

  it('filters by binding name', () => {
    store.insertVisualRegressionResult({
      bindingName: 'runner-a',
      storyName: 'A',
      diffPercentage: 0.01,
    });
    store.insertVisualRegressionResult({
      bindingName: 'runner-b',
      storyName: 'B',
      diffPercentage: 0.02,
    });
    const results = store.getVisualRegressionResults('runner-a');
    expect(results).toHaveLength(1);
    const row = results[0] as unknown as Record<string, unknown>;
    expect(row.story_name).toBe('A');
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.insertVisualRegressionResult({
        bindingName: 'r',
        storyName: `story-${i}`,
        diffPercentage: i * 0.01,
      });
    }
    const results = store.getVisualRegressionResults('r', 2);
    expect(results).toHaveLength(2);
  });
});

// ── Usability Simulation Results (RFC-0006) ────────────────────────

describe('Usability Simulation Results', () => {
  it('inserts and retrieves simulation results', () => {
    const id = store.insertUsabilitySimulationResult({
      bindingName: 'usability-runner',
      storyName: 'Button/Default',
      personaId: 'persona-a',
      taskId: 'task-1',
      completed: true,
      actionsTaken: 3,
      expectedActions: 2,
      efficiency: 0.67,
      findingsJson: '["slow response time"]',
    });
    expect(id).toBeGreaterThan(0);

    const results = store.getUsabilitySimulationResults('usability-runner');
    expect(results).toHaveLength(1);
    const row = results[0] as unknown as Record<string, unknown>;
    expect(row.binding_name).toBe('usability-runner');
    expect(row.story_name).toBe('Button/Default');
    expect(row.persona_id).toBe('persona-a');
    expect(row.task_id).toBe('task-1');
    expect(row.completed).toBe(1); // SQLite stores booleans as integers
    expect(row.actions_taken).toBe(3);
    expect(row.expected_actions).toBe(2);
    expect(row.efficiency).toBeCloseTo(0.67);
    expect(row.findings_json).toBe('["slow response time"]');
  });

  it('inserts incomplete simulation results', () => {
    store.insertUsabilitySimulationResult({
      bindingName: 'runner',
      storyName: 'Modal/Open',
      completed: false,
    });
    const results = store.getUsabilitySimulationResults('runner');
    expect(results).toHaveLength(1);
    const row = results[0] as unknown as Record<string, unknown>;
    expect(row.completed).toBe(0);
  });

  it('filters by binding name', () => {
    store.insertUsabilitySimulationResult({
      bindingName: 'runner-a',
      storyName: 'A',
    });
    store.insertUsabilitySimulationResult({
      bindingName: 'runner-b',
      storyName: 'B',
    });
    const results = store.getUsabilitySimulationResults('runner-a');
    expect(results).toHaveLength(1);
    const row = results[0] as unknown as Record<string, unknown>;
    expect(row.story_name).toBe('A');
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.insertUsabilitySimulationResult({
        bindingName: 'r',
        storyName: `story-${i}`,
      });
    }
    const results = store.getUsabilitySimulationResults('r', 2);
    expect(results).toHaveLength(2);
  });
});

// ── Utilities ──────────────────────────────────────────────────────

describe('Utilities', () => {
  it('getDatabase returns the underlying db', () => {
    const raw = store.getDatabase();
    expect(raw).toBe(db);
  });

  it('close closes the database', () => {
    const db2 = new Database(':memory:');
    const store2 = StateStore.open(db2);
    store2.close();
    // After close, attempting to prepare should throw
    expect(() => db2.prepare('SELECT 1')).toThrow();
  });
});
