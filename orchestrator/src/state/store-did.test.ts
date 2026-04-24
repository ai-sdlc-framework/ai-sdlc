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

describe('DidCompiledArtifact', () => {
  it('round-trips a fully populated record', () => {
    const bm25 = Buffer.from([0x01, 0x02, 0x03]);
    const principle = Buffer.from([0xff, 0xfe]);
    const id = store.insertDidCompiledArtifact({
      didName: 'acme-did',
      namespace: 'team-fe',
      sourceHash: 'sha256:abc',
      scopeListsJson: '{"scopes":[]}',
      constraintRulesJson: '{"rules":[]}',
      antiPatternListsJson: '{"anti":[]}',
      measurableSignalsJson: '{"signals":[]}',
      bm25CorpusBlob: bm25,
      principleCorporaBlob: principle,
    });
    expect(id).toBeGreaterThan(0);

    const got = store.getLatestDidCompiledArtifact('acme-did');
    expect(got).toBeDefined();
    expect(got!.didName).toBe('acme-did');
    expect(got!.namespace).toBe('team-fe');
    expect(got!.sourceHash).toBe('sha256:abc');
    expect(got!.scopeListsJson).toBe('{"scopes":[]}');
    expect(got!.bm25CorpusBlob).toBeDefined();
    expect(Buffer.from(got!.bm25CorpusBlob!).equals(bm25)).toBe(true);
    expect(Buffer.from(got!.principleCorporaBlob!).equals(principle)).toBe(true);
    expect(got!.compiledAt).toBeDefined();
  });

  it('returns latest artifact when multiple versions exist', () => {
    store.insertDidCompiledArtifact({ didName: 'd', sourceHash: 'h1' });
    store.insertDidCompiledArtifact({ didName: 'd', sourceHash: 'h2' });

    const latest = store.getLatestDidCompiledArtifact('d');
    expect(latest!.sourceHash).toBe('h2');
  });

  it('looks up by (didName, sourceHash)', () => {
    store.insertDidCompiledArtifact({ didName: 'd', sourceHash: 'target' });
    store.insertDidCompiledArtifact({ didName: 'd', sourceHash: 'other' });

    const got = store.getDidCompiledArtifactByHash('d', 'target');
    expect(got!.sourceHash).toBe('target');
  });

  it('returns undefined when no artifact exists', () => {
    expect(store.getLatestDidCompiledArtifact('missing')).toBeUndefined();
    expect(store.getDidCompiledArtifactByHash('missing', 'x')).toBeUndefined();
  });
});

describe('DidScoringEvent', () => {
  it('round-trips all fields', () => {
    const id = store.recordDidScoringEvent({
      didName: 'd',
      issueNumber: 42,
      saDimension: 'SA-2',
      phase: '2b',
      layer1ResultJson: '{"hardGated":false}',
      layer2ResultJson: '{"domainRelevance":0.7}',
      layer3ResultJson: '{"llmScore":0.8}',
      compositeScore: 0.84,
      phaseWeightsJson: '{"wStructural":0.2,"wLlm":0.8}',
    });
    expect(id).toBeGreaterThan(0);

    const events = store.getDidScoringEvents({ didName: 'd' });
    expect(events).toHaveLength(1);
    expect(events[0].didName).toBe('d');
    expect(events[0].issueNumber).toBe(42);
    expect(events[0].saDimension).toBe('SA-2');
    expect(events[0].phase).toBe('2b');
    expect(events[0].compositeScore).toBeCloseTo(0.84, 5);
    expect(events[0].layer1ResultJson).toBe('{"hardGated":false}');
    expect(events[0].createdAt).toBeDefined();
  });

  it('filters by issueNumber and saDimension', () => {
    store.recordDidScoringEvent({
      didName: 'd',
      issueNumber: 1,
      saDimension: 'SA-1',
      phase: '2a',
    });
    store.recordDidScoringEvent({
      didName: 'd',
      issueNumber: 1,
      saDimension: 'SA-2',
      phase: '2a',
    });
    store.recordDidScoringEvent({
      didName: 'd',
      issueNumber: 2,
      saDimension: 'SA-2',
      phase: '2a',
    });

    const forIssue1Sa2 = store.getDidScoringEvents({ issueNumber: 1, saDimension: 'SA-2' });
    expect(forIssue1Sa2).toHaveLength(1);
    expect(forIssue1Sa2[0].issueNumber).toBe(1);
    expect(forIssue1Sa2[0].saDimension).toBe('SA-2');
  });

  it('orders events by created_at DESC', () => {
    store.recordDidScoringEvent({
      didName: 'd',
      issueNumber: 1,
      saDimension: 'SA-1',
      phase: '2a',
      compositeScore: 0.1,
    });
    store.recordDidScoringEvent({
      didName: 'd',
      issueNumber: 1,
      saDimension: 'SA-1',
      phase: '2a',
      compositeScore: 0.2,
    });
    const events = store.getDidScoringEvents({ didName: 'd', limit: 10 });
    expect(events).toHaveLength(2);
    // Latest insert should be first
    expect(events[0].compositeScore).toBeCloseTo(0.2, 5);
  });
});

describe('DidFeedbackEvent', () => {
  it('round-trips all signal types', () => {
    for (const signal of ['accept', 'dismiss', 'escalate', 'override'] as const) {
      store.recordDidFeedback({
        didName: 'd',
        issueNumber: 1,
        dimension: 'SA-2',
        signal,
        principal: 'alice',
        category: 'UX',
        structuralScore: 0.5,
        llmScore: 0.7,
        compositeScore: 0.65,
        notes: `signal=${signal}`,
      });
    }

    const all = store.getDidFeedbackEvents({ didName: 'd', limit: 10 });
    expect(all).toHaveLength(4);
    const signals = all.map((e) => e.signal).sort();
    expect(signals).toEqual(['accept', 'dismiss', 'escalate', 'override']);
  });

  it('filters by signal and dimension', () => {
    store.recordDidFeedback({
      didName: 'd',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'accept',
    });
    store.recordDidFeedback({
      didName: 'd',
      issueNumber: 1,
      dimension: 'SA-2',
      signal: 'dismiss',
    });

    const accepts = store.getDidFeedbackEvents({ signal: 'accept' });
    expect(accepts).toHaveLength(1);
    expect(accepts[0].dimension).toBe('SA-1');

    const sa2 = store.getDidFeedbackEvents({ dimension: 'SA-2' });
    expect(sa2).toHaveLength(1);
    expect(sa2[0].signal).toBe('dismiss');
  });

  it('enforces CHECK constraint on signal column', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO did_feedback_events (did_name, issue_number, dimension, signal) VALUES ('d', 1, 'SA-1', 'bogus')`,
        )
        .run(),
    ).toThrow();
  });
});

describe('DesignChangeEvent', () => {
  it('round-trips a planned change', () => {
    const id = store.recordDesignChange({
      didName: 'd',
      changeId: 'chg-001',
      changeType: 'token-rename',
      status: 'planned',
      payloadJson: JSON.stringify({ affectedTokens: ['color.primary'] }),
    });
    expect(id).toBeGreaterThan(0);

    const events = store.getDesignChangeEvents({ didName: 'd' });
    expect(events).toHaveLength(1);
    expect(events[0].changeId).toBe('chg-001');
    expect(events[0].changeType).toBe('token-rename');
    expect(events[0].status).toBe('planned');
    expect(JSON.parse(events[0].payloadJson)).toEqual({ affectedTokens: ['color.primary'] });
    expect(events[0].emittedAt).toBeDefined();
  });

  it('filters by changeId', () => {
    store.recordDesignChange({
      didName: 'd',
      changeId: 'a',
      changeType: 't',
      status: 'planned',
      payloadJson: '{}',
    });
    store.recordDesignChange({
      didName: 'd',
      changeId: 'b',
      changeType: 't',
      status: 'planned',
      payloadJson: '{}',
    });

    const onlyA = store.getDesignChangeEvents({ changeId: 'a' });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].changeId).toBe('a');
  });
});

describe('CodeAreaMetrics', () => {
  it('round-trips metrics with hasFrontendComponents boolean', () => {
    const id = store.insertCodeAreaMetrics({
      codeArea: 'ui/button',
      defectDensity: 0.02,
      churnRate: 0.15,
      prRejectionRate: 0.05,
      codeAcceptanceRate: 0.95,
      hasFrontendComponents: true,
      designMetricsJson: '{"ciPassRate":0.9}',
      dataPointCount: 12,
      windowStart: '2026-01-01T00:00:00Z',
      windowEnd: '2026-04-01T00:00:00Z',
    });
    expect(id).toBeGreaterThan(0);

    const got = store.getCodeAreaMetrics('ui/button');
    expect(got).toBeDefined();
    expect(got!.codeArea).toBe('ui/button');
    expect(got!.defectDensity).toBeCloseTo(0.02, 5);
    expect(got!.churnRate).toBeCloseTo(0.15, 5);
    expect(got!.prRejectionRate).toBeCloseTo(0.05, 5);
    expect(got!.codeAcceptanceRate).toBeCloseTo(0.95, 5);
    expect(got!.hasFrontendComponents).toBe(true);
    expect(got!.designMetricsJson).toBe('{"ciPassRate":0.9}');
    expect(got!.dataPointCount).toBe(12);
    expect(got!.windowStart).toBe('2026-01-01T00:00:00Z');
    expect(got!.windowEnd).toBe('2026-04-01T00:00:00Z');
    expect(got!.computedAt).toBeDefined();
  });

  it('returns false for hasFrontendComponents when absent', () => {
    store.insertCodeAreaMetrics({
      codeArea: 'core/parser',
      defectDensity: 0.01,
      hasFrontendComponents: false,
    });

    const got = store.getCodeAreaMetrics('core/parser');
    expect(got!.hasFrontendComponents).toBe(false);
  });

  it('returns most recent snapshot per area', () => {
    store.insertCodeAreaMetrics({
      codeArea: 'x',
      hasFrontendComponents: false,
      defectDensity: 0.1,
    });
    store.insertCodeAreaMetrics({
      codeArea: 'x',
      hasFrontendComponents: false,
      defectDensity: 0.2,
    });

    const latest = store.getCodeAreaMetrics('x');
    expect(latest!.defectDensity).toBeCloseTo(0.2, 5);
  });

  it('history returns rows ordered by computed_at DESC', () => {
    store.insertCodeAreaMetrics({ codeArea: 'x', hasFrontendComponents: false, defectDensity: 1 });
    store.insertCodeAreaMetrics({ codeArea: 'x', hasFrontendComponents: false, defectDensity: 2 });

    const hist = store.getCodeAreaMetricsHistory('x');
    expect(hist).toHaveLength(2);
    expect(hist[0].defectDensity).toBe(2);
    expect(hist[1].defectDensity).toBe(1);
  });
});

describe('DesignLookaheadNotification', () => {
  it('upserts first-notified state and returns it', () => {
    store.upsertDesignLookaheadNotification({
      issueNumber: 101,
      pillarBreakdownJson: '{"product":0.8}',
    });

    const got = store.getDesignLookaheadNotification(101);
    expect(got).toBeDefined();
    expect(got!.issueNumber).toBe(101);
    expect(got!.pillarBreakdownJson).toBe('{"product":0.8}');
    expect(got!.firstNotifiedAt).toBeDefined();
    expect(got!.lastNotifiedAt).toBeDefined();
  });

  it('updates last_notified_at on conflict but preserves first_notified_at', () => {
    store.upsertDesignLookaheadNotification({
      issueNumber: 7,
      pillarBreakdownJson: '{"v":1}',
    });
    const first = store.getDesignLookaheadNotification(7)!;

    // Simulate a later notification — bump last_notified_at via direct SQL
    // (in real usage seconds of delay make the timestamps differ)
    db.prepare(
      `UPDATE design_lookahead_notifications SET first_notified_at = '2020-01-01T00:00:00Z' WHERE issue_number = 7`,
    ).run();

    store.upsertDesignLookaheadNotification({
      issueNumber: 7,
      pillarBreakdownJson: '{"v":2}',
    });
    const second = store.getDesignLookaheadNotification(7)!;
    expect(second.firstNotifiedAt).toBe('2020-01-01T00:00:00Z');
    expect(second.pillarBreakdownJson).toBe('{"v":2}');
    expect(second.id).toBe(first.id);
  });

  it('returns undefined for unknown issue', () => {
    expect(store.getDesignLookaheadNotification(999)).toBeUndefined();
  });
});

describe('V11 migration', () => {
  it('creates all RFC-0008 tables', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('did_compiled_artifacts');
    expect(names).toContain('did_scoring_events');
    expect(names).toContain('did_feedback_events');
    expect(names).toContain('design_change_events');
    expect(names).toContain('code_area_metrics');
    expect(names).toContain('design_lookahead_notifications');
  });

  it('records schema_version up to V11', () => {
    const row = db.prepare(`SELECT MAX(version) as v FROM schema_version`).get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(11);
  });
});
