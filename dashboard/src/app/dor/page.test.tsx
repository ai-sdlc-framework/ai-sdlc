import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CalibrationEntry, CorpusReport } from '@ai-sdlc/pipeline-cli/dor-corpus';

const mockLoad = vi.fn();

vi.mock('@/lib/dor-data', () => ({
  loadDorData: () => mockLoad(),
}));

vi.mock('@/components/layout/header', () => ({
  Header: ({ title, subtitle }: { title: string; subtitle?: string }) => ({
    type: 'mock-header',
    props: { title, subtitle },
  }),
}));

vi.mock('@/components/cards/stat-card', () => ({
  StatCard: (props: Record<string, unknown>) => ({
    type: 'mock-stat-card',
    props,
  }),
}));

vi.mock('@/components/cards/recommendation-badge', () => ({
  RecommendationBadge: (props: Record<string, unknown>) => ({
    type: 'mock-recommendation-badge',
    props,
  }),
}));

function makeReport(overrides: Partial<CorpusReport['aggregate']> = {}): CorpusReport {
  return {
    perGate: [],
    aggregate: {
      n: 0,
      meanFpRate: 0,
      overrideRate: 0,
      worstGate: null,
      recommendation: 'insufficient-data',
      reason: 'no data',
      skipped: 0,
      filesRead: 0,
      ...overrides,
    },
  };
}

function makeEntry(overrides: Partial<CalibrationEntry> = {}): CalibrationEntry {
  return {
    ts: '2026-05-01T00:00:00.000Z',
    issueId: 'AISDLC-test',
    rubricVersion: 'v1',
    evaluatorVersion: 'test',
    overallVerdict: 'admit',
    failedGates: [],
    outcome: '',
    verdict: {
      issueId: 'AISDLC-test',
      rubricVersion: 'v1',
      overallVerdict: 'admit',
      gates: [],
      signedAt: '2026-05-01T00:00:00.000Z',
      evaluatorVersion: 'test',
      summary: '',
      questions: [],
    },
    ...overrides,
  };
}

describe('DorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty-state hint when no corpus is found', async () => {
    mockLoad.mockReturnValueOnce(null);
    const { default: DorPage } = await import('./page');
    const result = DorPage();
    expect(result).toBeTruthy();
    expect(result.type).toBe('div');
  });

  it('renders the safe-to-enforce path with per-gate data', async () => {
    mockLoad.mockReturnValueOnce({
      corpusRoot: '/tmp/dor',
      report: {
        perGate: [
          { gate: 1, n: 100, overrides: 5, fpRate: 0.05, overrideRate: 0.05 },
          { gate: 3, n: 200, overrides: 18, fpRate: 0.09, overrideRate: 0.09 },
        ],
        aggregate: {
          n: 1000,
          meanFpRate: 0.07,
          overrideRate: 0.018,
          worstGate: { gate: 3, fpRate: 0.09 },
          recommendation: 'safe-to-enforce',
          reason: 'all clear',
          skipped: 0,
          filesRead: 5,
        },
      },
      recentEntries: [
        makeEntry({ issueId: 'AISDLC-1', outcome: 'admit' }),
        makeEntry({ issueId: 'AISDLC-2', outcome: 'override', failedGates: [3] }),
      ],
    });
    const { default: DorPage } = await import('./page');
    const result = DorPage();
    expect(result).toBeTruthy();
  });

  it('renders the continue-soak path with a worst-offender gate', async () => {
    mockLoad.mockReturnValueOnce({
      corpusRoot: '/tmp/dor',
      report: makeReport({
        n: 60,
        meanFpRate: 0.5,
        overrideRate: 0.16,
        worstGate: { gate: 2, fpRate: 0.5 },
        recommendation: 'continue-soak',
        reason: 'gate-2 fpRate=50% exceeds threshold=10%',
        filesRead: 1,
      }),
      recentEntries: [makeEntry()],
    });
    const { default: DorPage } = await import('./page');
    const result = DorPage();
    expect(result).toBeTruthy();
  });

  it('renders insufficient-data with empty perGate + entries', async () => {
    mockLoad.mockReturnValueOnce({
      corpusRoot: '/tmp/dor',
      report: makeReport({ filesRead: 0 }),
      recentEntries: [],
    });
    const { default: DorPage } = await import('./page');
    const result = DorPage();
    expect(result).toBeTruthy();
  });
});
