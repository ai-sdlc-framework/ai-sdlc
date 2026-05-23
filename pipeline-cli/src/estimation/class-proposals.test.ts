/**
 * class-proposals tests — RFC-0016 Phase 6 (AISDLC-284).
 *
 * Covers:
 *  - AC #4: `cli-estimate-classes review` lists pending class proposals.
 *  - AC #5: Auto-promote when >=3 proposals of same shape.
 *  - readProposals, appendProposal, clusterProposals, autoPromote.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendProposal,
  autoPromote,
  clusterProposals,
  listPendingProposals,
  readClassesYaml,
  readProposals,
} from './class-proposals.js';
import type { ClassProposal } from './class-proposals.js';

// ── Helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `class-proposals-test-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const EXAMPLE_PROPOSAL: Omit<ClassProposal, 'accepted'> = {
  ts: '2026-05-01T10:00:00Z',
  taskId: 'AISDLC-200',
  proposedClass: 'docs-rewrite',
  structure: {
    definition: 'Structural rewrite of documentation files with no code change.',
    exemplars: ['Rewrite RFC-0016 to include implementation examples'],
    anti_patterns: ['Update changelog (this is chore)'],
    synonyms: ['doc-rewrite', 'docs-overhaul'],
  },
  confidence: 0.78,
  rationale: 'Task is a structural rewrite of multiple .md files',
};

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── readProposals ─────────────────────────────────────────────────────────

describe('readProposals', () => {
  it('returns empty array when file does not exist', () => {
    expect(readProposals({ aiSdlcDir: tmpDir })).toEqual([]);
  });

  it('reads proposals appended via appendProposal', () => {
    appendProposal({ aiSdlcDir: tmpDir, proposal: EXAMPLE_PROPOSAL });
    const proposals = readProposals({ aiSdlcDir: tmpDir });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.proposedClass).toBe('docs-rewrite');
    expect(proposals[0]!.confidence).toBe(0.78);
  });
});

// ── appendProposal ────────────────────────────────────────────────────────

describe('appendProposal', () => {
  it('creates the directory if it does not exist', () => {
    const nested = join(tmpDir, 'sub', 'dir');
    const ok = appendProposal({ aiSdlcDir: nested, proposal: EXAMPLE_PROPOSAL });
    expect(ok).toBe(true);
    expect(readProposals({ aiSdlcDir: nested })).toHaveLength(1);
  });

  it('appends multiple proposals', () => {
    appendProposal({ aiSdlcDir: tmpDir, proposal: EXAMPLE_PROPOSAL });
    appendProposal({
      aiSdlcDir: tmpDir,
      proposal: { ...EXAMPLE_PROPOSAL, taskId: 'AISDLC-201', ts: '2026-05-02T10:00:00Z' },
    });
    expect(readProposals({ aiSdlcDir: tmpDir })).toHaveLength(2);
  });
});

// ── clusterProposals ──────────────────────────────────────────────────────

describe('clusterProposals', () => {
  it('returns empty array when no proposals', () => {
    expect(clusterProposals({ aiSdlcDir: tmpDir })).toEqual([]);
  });

  it('clusters same-name proposals together', () => {
    for (let i = 0; i < 3; i++) {
      appendProposal({
        aiSdlcDir: tmpDir,
        proposal: {
          ...EXAMPLE_PROPOSAL,
          taskId: `AISDLC-${200 + i}`,
          ts: `2026-05-0${i + 1}T10:00:00Z`,
        },
      });
    }
    const clusters = clusterProposals({ aiSdlcDir: tmpDir });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.canonicalName).toBe('docs-rewrite');
    expect(clusters[0]!.count).toBe(3);
    expect(clusters[0]!.autoPromotable).toBe(true);
  });

  it('separates different-name proposals into different clusters', () => {
    appendProposal({
      aiSdlcDir: tmpDir,
      proposal: { ...EXAMPLE_PROPOSAL, proposedClass: 'docs-rewrite' },
    });
    appendProposal({
      aiSdlcDir: tmpDir,
      proposal: { ...EXAMPLE_PROPOSAL, proposedClass: 'infra-rebuild', taskId: 'AISDLC-300' },
    });
    const clusters = clusterProposals({ aiSdlcDir: tmpDir });
    expect(clusters).toHaveLength(2);
  });

  it('marks autoPromotable=false when count < threshold', () => {
    appendProposal({ aiSdlcDir: tmpDir, proposal: EXAMPLE_PROPOSAL });
    appendProposal({
      aiSdlcDir: tmpDir,
      proposal: { ...EXAMPLE_PROPOSAL, taskId: 'AISDLC-201', ts: '2026-05-02T10:00:00Z' },
    });
    const clusters = clusterProposals({
      aiSdlcDir: tmpDir,
      autoPromoteThreshold: 3,
    });
    expect(clusters[0]!.count).toBe(2);
    expect(clusters[0]!.autoPromotable).toBe(false);
  });

  it('sorts newest proposals first within a cluster', () => {
    appendProposal({
      aiSdlcDir: tmpDir,
      proposal: { ...EXAMPLE_PROPOSAL, ts: '2026-05-01T10:00:00Z', taskId: 'OLD' },
    });
    appendProposal({
      aiSdlcDir: tmpDir,
      proposal: { ...EXAMPLE_PROPOSAL, ts: '2026-05-03T10:00:00Z', taskId: 'NEW' },
    });
    const cluster = clusterProposals({ aiSdlcDir: tmpDir })[0]!;
    expect(cluster.proposals[0]!.taskId).toBe('NEW');
    expect(cluster.proposals[1]!.taskId).toBe('OLD');
  });
});

// ── autoPromote ───────────────────────────────────────────────────────────

describe('autoPromote — AC #5', () => {
  it('returns promotedCount=0 when no auto-promotable clusters', () => {
    const result = autoPromote({ aiSdlcDir: tmpDir });
    expect(result.promotedCount).toBe(0);
    expect(result.yamlUpdated).toBe(false);
  });

  it('promotes a cluster with >=3 proposals to estimate-classes.yaml', () => {
    for (let i = 0; i < 3; i++) {
      appendProposal({
        aiSdlcDir: tmpDir,
        proposal: {
          ...EXAMPLE_PROPOSAL,
          taskId: `AISDLC-${200 + i}`,
          ts: `2026-05-0${i + 1}T10:00:00Z`,
        },
      });
    }

    const result = autoPromote({
      aiSdlcDir: tmpDir,
      now: () => new Date('2026-05-17T10:00:00Z'),
    });

    expect(result.promotedCount).toBe(1);
    expect(result.promotedClasses).toContain('docs-rewrite');
    expect(result.yamlUpdated).toBe(true);

    // Verify the class was written to estimate-classes.yaml.
    const classes = readClassesYaml(tmpDir);
    expect('docs-rewrite' in classes).toBe(true);
  });

  it('does not promote the same class twice', () => {
    for (let i = 0; i < 3; i++) {
      appendProposal({
        aiSdlcDir: tmpDir,
        proposal: { ...EXAMPLE_PROPOSAL, taskId: `AISDLC-${200 + i}` },
      });
    }
    autoPromote({ aiSdlcDir: tmpDir });
    // Second call: class already exists — no promotion
    const result2 = autoPromote({ aiSdlcDir: tmpDir });
    expect(result2.promotedCount).toBe(0);
    expect(result2.yamlUpdated).toBe(false);
  });

  it('does not promote built-in starter classes when proposed', () => {
    // Even if someone proposes a class named "bug" with 3+ instances,
    // it should NOT clobber the starter.
    for (let i = 0; i < 3; i++) {
      appendProposal({
        aiSdlcDir: tmpDir,
        proposal: {
          ...EXAMPLE_PROPOSAL,
          proposedClass: 'bug',
          taskId: `AISDLC-${200 + i}`,
        },
      });
    }
    const result = autoPromote({ aiSdlcDir: tmpDir });
    // 'bug' already in starter classes — skip, 0 new promotions.
    expect(result.promotedCount).toBe(0);
    expect(result.yamlUpdated).toBe(false);
  });
});

// ── readClassesYaml ───────────────────────────────────────────────────────

describe('readClassesYaml', () => {
  it('returns starter classes when file does not exist', () => {
    const classes = readClassesYaml(tmpDir);
    expect(Object.keys(classes).sort()).toEqual(['bug', 'chore', 'feature']);
  });

  it('includes newly promoted classes after autoPromote', () => {
    for (let i = 0; i < 3; i++) {
      appendProposal({
        aiSdlcDir: tmpDir,
        proposal: { ...EXAMPLE_PROPOSAL, taskId: `AISDLC-${200 + i}` },
      });
    }
    autoPromote({ aiSdlcDir: tmpDir });
    const classes = readClassesYaml(tmpDir);
    expect('docs-rewrite' in classes).toBe(true);
  });
});

// ── listPendingProposals (AC #4 surface) ──────────────────────────────────

describe('listPendingProposals', () => {
  it('returns empty list when no proposals', () => {
    expect(listPendingProposals({ aiSdlcDir: tmpDir })).toEqual([]);
  });

  it('lists clusters sorted by count descending', () => {
    // 3 docs-rewrite + 1 infra-rebuild
    for (let i = 0; i < 3; i++) {
      appendProposal({
        aiSdlcDir: tmpDir,
        proposal: { ...EXAMPLE_PROPOSAL, taskId: `DR-${i}` },
      });
    }
    appendProposal({
      aiSdlcDir: tmpDir,
      proposal: { ...EXAMPLE_PROPOSAL, proposedClass: 'infra-rebuild', taskId: 'IR-1' },
    });

    const pending = listPendingProposals({ aiSdlcDir: tmpDir });
    expect(pending[0]!.canonicalName).toBe('docs-rewrite');
    expect(pending[0]!.count).toBe(3);
    expect(pending[1]!.canonicalName).toBe('infra-rebuild');
  });
});
