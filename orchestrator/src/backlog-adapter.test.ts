import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseBacklogTask,
  loadBacklogTaskFromRoot,
  mapBacklogTaskToAdmissionInput,
  loadSoulTracks,
  type BacklogTaskSnapshot,
} from './backlog-adapter.js';

const FIXTURE = `---
id: AISDLC-42
title: Add Backlog tracker adapter
status: To Do
priority: high
labels:
  - priority:p1
  - size:M
  - track:reflect
  - source:rfc
created_date: '2026-04-25 09:00'
updated_date: '2026-04-25 09:00'
created_by: alice
references:
  - orchestrator/src/admission-score.ts
  - orchestrator/src/cli-admit.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the Backlog.md tracker adapter so admission scoring works on
non-GitHub trackers.

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Frontmatter parser handles labels, references, dates
- [x] #2 Label-mapping table covers priority/size/track/source
- [ ] #3 Quality flags surface zombie closes
- [ ] #4 cli-admit dispatch picks the right tracker
- [ ] #5 --config-root resolves cross-repo enrichment
<!-- AC:END -->
`;

function snapWith(overrides: Partial<BacklogTaskSnapshot>): BacklogTaskSnapshot {
  return {
    id: 'TASK-1',
    numericId: 1,
    title: 't',
    description: '',
    status: 'To Do',
    priority: null,
    labels: [],
    createdDate: '2026-04-25 09:00',
    updatedDate: '2026-04-25 09:00',
    acceptanceCriteria: [],
    references: [],
    ...overrides,
  };
}

describe('parseBacklogTask', () => {
  it('parses frontmatter, description, and AC checklist', () => {
    const snap = parseBacklogTask(FIXTURE);
    expect(snap.id).toBe('AISDLC-42');
    expect(snap.numericId).toBe(42);
    expect(snap.title).toBe('Add Backlog tracker adapter');
    expect(snap.status).toBe('To Do');
    expect(snap.priority).toBe('high');
    expect(snap.labels).toEqual(['priority:p1', 'size:M', 'track:reflect', 'source:rfc']);
    expect(snap.references).toHaveLength(2);
    expect(snap.createdBy).toBe('alice');
    expect(snap.acceptanceCriteria).toHaveLength(5);
    expect(snap.acceptanceCriteria[0]).toEqual({
      index: 1,
      text: 'Frontmatter parser handles labels, references, dates',
      checked: true,
    });
    expect(snap.acceptanceCriteria[2].checked).toBe(false);
    expect(snap.description).toContain('Implement the Backlog.md tracker adapter');
  });

  it('throws on missing frontmatter', () => {
    expect(() => parseBacklogTask('no frontmatter here')).toThrow(/missing YAML frontmatter/);
  });

  it('throws on missing id', () => {
    const noId = '---\ntitle: No id\n---\n\nbody';
    expect(() => parseBacklogTask(noId)).toThrow(/missing `id`/);
  });

  it('handles empty acceptance criteria gracefully', () => {
    const minimal = `---\nid: AISDLC-1\ntitle: t\nstatus: To Do\n---\n\n## Description\n\nfoo`;
    const snap = parseBacklogTask(minimal);
    expect(snap.acceptanceCriteria).toEqual([]);
  });

  it('handles inline `[]` empty labels', () => {
    const fm = `---\nid: AISDLC-2\ntitle: t\nstatus: To Do\nlabels: []\n---\n\nbody`;
    const snap = parseBacklogTask(fm);
    expect(snap.labels).toEqual([]);
  });
});

describe('loadBacklogTaskFromRoot', () => {
  it('finds a task in backlog/tasks/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'backlog-load-'));
    try {
      mkdirSync(join(tmp, 'backlog', 'tasks'), { recursive: true });
      writeFileSync(
        join(tmp, 'backlog', 'tasks', 'aisdlc-7 - Hello.md'),
        `---\nid: AISDLC-7\ntitle: Hello\nstatus: To Do\n---\n`,
      );
      const snap = loadBacklogTaskFromRoot(tmp, 'AISDLC-7');
      expect(snap?.id).toBe('AISDLC-7');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('finds a completed task in backlog/completed/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'backlog-load-'));
    try {
      mkdirSync(join(tmp, 'backlog', 'completed'), { recursive: true });
      writeFileSync(
        join(tmp, 'backlog', 'completed', 'aisdlc-9 - Done.md'),
        `---\nid: AISDLC-9\ntitle: Done\nstatus: Done\n---\n`,
      );
      expect(loadBacklogTaskFromRoot(tmp, 'AISDLC-9')?.id).toBe('AISDLC-9');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('returns undefined when no matching file exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'backlog-load-'));
    try {
      expect(loadBacklogTaskFromRoot(tmp, 'NOPE-1')).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

describe('mapBacklogTaskToAdmissionInput — label mapping', () => {
  it('priority:p0 → explicitPriority 1.0', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ labels: ['priority:p0'] }));
    expect(m.priorityInputOverrides.explicitPriority).toBe(1.0);
  });

  it('priority:p1 → 0.75, priority:p2 → 0.5, priority:p3 → 0.25', () => {
    expect(
      mapBacklogTaskToAdmissionInput(snapWith({ labels: ['priority:p1'] })).priorityInputOverrides
        .explicitPriority,
    ).toBe(0.75);
    expect(
      mapBacklogTaskToAdmissionInput(snapWith({ labels: ['priority:p2'] })).priorityInputOverrides
        .explicitPriority,
    ).toBe(0.5);
    expect(
      mapBacklogTaskToAdmissionInput(snapWith({ labels: ['priority:p3'] })).priorityInputOverrides
        .explicitPriority,
    ).toBe(0.25);
  });

  it('falls back to frontmatter priority field when no priority:p* label', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ priority: 'high' }));
    expect(m.priorityInputOverrides.explicitPriority).toBe(0.75);
  });

  it('size:S/M/L/XL → complexity 2/5/7/9', () => {
    const get = (label: string) =>
      mapBacklogTaskToAdmissionInput(snapWith({ labels: [label] })).priorityInputOverrides
        .complexity;
    expect(get('size:S')).toBe(2);
    expect(get('size:M')).toBe(5);
    expect(get('size:L')).toBe(7);
    expect(get('size:XL')).toBe(9);
  });

  it('source:rfc → soulAlignment 0.9', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ labels: ['source:rfc'] }));
    expect(m.priorityInputOverrides.soulAlignment).toBe(0.9);
  });

  it('governance/compliance → soulAlignment 0.85', () => {
    expect(
      mapBacklogTaskToAdmissionInput(snapWith({ labels: ['governance'] })).priorityInputOverrides
        .soulAlignment,
    ).toBe(0.85);
  });

  it('track:* uses soul-tracks.json overrides', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ labels: ['track:enchantment'] }), {
      soulTracks: { 'track:enchantment': 0.85 },
    });
    expect(m.priorityInputOverrides.soulAlignment).toBe(0.85);
  });

  it('default soul-track for track:ops is 0.55', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ labels: ['track:ops'] }));
    expect(m.priorityInputOverrides.soulAlignment).toBe(0.55);
  });

  it('bug → bugSeverity 3', () => {
    expect(
      mapBacklogTaskToAdmissionInput(snapWith({ labels: ['bug'] })).priorityInputOverrides
        .bugSeverity,
    ).toBe(3);
  });

  it('security → bugSeverity 5 + soulAlignment floor 0.7', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ labels: ['security'] }));
    expect(m.priorityInputOverrides.bugSeverity).toBe(5);
    expect(m.priorityInputOverrides.soulAlignment).toBe(0.7);
  });

  it('source:*-tonight → demandSignal 0.7 + competitiveDrift bump', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ labels: ['source:s186-tonight'] }));
    expect(m.priorityInputOverrides.demandSignal).toBe(0.7);
    expect(m.priorityInputOverrides.competitiveDrift).toBeCloseTo(0.2, 6);
  });

  it('scope:v1-ship + tonight → competitiveDrift saturates near 0.8', () => {
    const m = mapBacklogTaskToAdmissionInput(
      snapWith({ labels: ['scope:v1-ship', 'source:s1-tonight'] }),
    );
    expect(m.priorityInputOverrides.competitiveDrift).toBeCloseTo(0.8, 6);
  });

  it('competitiveDrift caps at 1.0', () => {
    const m = mapBacklogTaskToAdmissionInput(
      snapWith({
        labels: ['scope:v1-ship', 'source:a-tonight', 'source:b-tonight', 'source:c-tonight'],
      }),
    );
    expect(m.priorityInputOverrides.competitiveDrift).toBe(1);
  });

  it('multiple references → builderConviction 0.7', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ references: ['a.ts', 'b.ts'] }));
    expect(m.priorityInputOverrides.builderConviction).toBe(0.7);
  });

  it('single reference → builderConviction 0.6', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ references: ['a.ts'] }));
    expect(m.priorityInputOverrides.builderConviction).toBe(0.6);
  });

  it('OWNER author-association when createdBy is in maintainers list', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ createdBy: 'alice' }), {
      maintainers: ['alice'],
    });
    expect(m.input.authorAssociation).toBe('OWNER');
  });

  it('MEMBER author-association by default', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({ createdBy: 'bob' }));
    expect(m.input.authorAssociation).toBe('MEMBER');
  });
});

describe('mapBacklogTaskToAdmissionInput — AC progress + quality flags', () => {
  function snapACs(total: number, checked: number, status = 'Done'): BacklogTaskSnapshot {
    return snapWith({
      status,
      acceptanceCriteria: Array.from({ length: total }, (_, i) => ({
        index: i + 1,
        text: `ac ${i + 1}`,
        checked: i < checked,
      })),
    });
  }

  it('derives complexity from AC count when no size label is present', () => {
    const m = mapBacklogTaskToAdmissionInput(snapACs(7, 7, 'To Do'));
    // 1 + 7 × 0.6 = 5.2
    expect(m.priorityInputOverrides.complexity).toBeCloseTo(5.2, 6);
  });

  it('AC complexity caps at 9', () => {
    const m = mapBacklogTaskToAdmissionInput(snapACs(20, 0, 'To Do'));
    expect(m.priorityInputOverrides.complexity).toBe(9);
  });

  it('size label wins over AC-derived complexity', () => {
    const snap = { ...snapACs(20, 0, 'To Do'), labels: ['size:S'] };
    const m = mapBacklogTaskToAdmissionInput(snap);
    expect(m.priorityInputOverrides.complexity).toBe(2);
  });

  it('Done with all ACs checked → no quality flag', () => {
    const m = mapBacklogTaskToAdmissionInput(snapACs(5, 5, 'Done'));
    expect(m.qualityFlags).toEqual([]);
    expect(m.priorityInputOverrides.defectRiskFactor).toBeUndefined();
    expect(m.priorityInputOverrides.qualityFlags).toBeUndefined();
  });

  it('Done with 5/7 checked → medium-severity zombie close + defectRiskFactor 0.15', () => {
    const m = mapBacklogTaskToAdmissionInput(snapACs(7, 5, 'Done'));
    expect(m.qualityFlags).toHaveLength(1);
    expect(m.qualityFlags[0].kind).toBe('unchecked-acs-on-done');
    expect(m.qualityFlags[0].severity).toBe('medium');
    expect(m.qualityFlags[0].detail).toBe('2/7 ACs unchecked');
    expect(m.priorityInputOverrides.defectRiskFactor).toBe(0.15);
    expect(m.priorityInputOverrides.qualityFlags).toEqual(m.qualityFlags);
  });

  it('Done with 0/5 checked → high-severity zombie close + defectRiskFactor 0.3', () => {
    const m = mapBacklogTaskToAdmissionInput(snapACs(5, 0, 'Done'));
    expect(m.qualityFlags[0].severity).toBe('high');
    expect(m.priorityInputOverrides.defectRiskFactor).toBe(0.3);
  });

  it('To Do with 0/5 checked → no flag (only Done qualifies as zombie)', () => {
    const m = mapBacklogTaskToAdmissionInput(snapACs(5, 0, 'To Do'));
    expect(m.qualityFlags).toEqual([]);
  });
});

describe('mapBacklogTaskToAdmissionInput — body construction', () => {
  it('renders Description + ### Complexity + ### Acceptance Criteria into body', () => {
    const m = mapBacklogTaskToAdmissionInput(
      snapWith({
        description: 'A short description.',
        labels: ['size:M'],
        acceptanceCriteria: [
          { index: 1, text: 'first', checked: true },
          { index: 2, text: 'second', checked: false },
        ],
      }),
    );
    expect(m.input.body).toContain('A short description.');
    expect(m.input.body).toContain('### Complexity\n\n5');
    expect(m.input.body).toContain('### Acceptance Criteria');
    expect(m.input.body).toContain('- [x] first');
    expect(m.input.body).toContain('- [ ] second');
  });
});

describe('mapBacklogTaskToAdmissionInput — date normalisation', () => {
  it('coerces "2026-04-25 09:00" to ISO', () => {
    const m = mapBacklogTaskToAdmissionInput(snapWith({}));
    expect(m.input.createdAt).toBe('2026-04-25T09:00:00Z');
  });
});

describe('loadSoulTracks', () => {
  it('returns empty object when file absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'soul-tracks-'));
    try {
      expect(loadSoulTracks(tmp)).toEqual({});
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('reads valid JSON and filters to numeric values in [0,1]', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'soul-tracks-'));
    try {
      mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(tmp, '.ai-sdlc', 'soul-tracks.json'),
        JSON.stringify({
          'track:enchantment': 0.85,
          'track:reflect': 0.9,
          'track:bogus': 1.5, // out of range
          'track:wrong-type': 'high',
        }),
      );
      const tracks = loadSoulTracks(tmp);
      expect(tracks).toEqual({
        'track:enchantment': 0.85,
        'track:reflect': 0.9,
      });
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('returns empty on malformed JSON without throwing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'soul-tracks-'));
    try {
      mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
      writeFileSync(join(tmp, '.ai-sdlc', 'soul-tracks.json'), '{not json');
      expect(loadSoulTracks(tmp)).toEqual({});
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});
