import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildLeafManifest, executeTranscriptFiles } from './leaves.js';

describe('executeTranscriptFiles', () => {
  it('names each probe transcript and verdict stub under the worktree, safely', () => {
    const f = executeTranscriptFiles('/wt', 'AISDLC-676');
    expect(f.transcriptDir).toBe(join('/wt', '.ai-sdlc', 'transcripts', 'aisdlc-676'));
    expect(f.verdictDir).toBe(join('/wt', '.ai-sdlc', 'verdicts'));
    const p = f.forProbe('hunk/read:0');
    expect(p.transcriptPath).toBe(join(f.transcriptDir, 'staged-review-execute-hunk_read_0.jsonl'));
    expect(p.verdictPath).toBe(
      join(f.verdictDir, 'staged-review-execute-hunk_read_0-aisdlc-676.json'),
    );
  });
});

describe('buildLeafManifest', () => {
  const executeLeaves = [
    { probeId: 'b', transcriptPath: '/t/b', verdictPath: '/v/b', harness: 'codex', model: 'codex' },
    {
      probeId: 'a',
      transcriptPath: '/t/a',
      verdictPath: '/v/a',
      harness: 'claude-code',
      model: 'haiku',
    },
  ];

  it('lists planner, probes in id order, then synthesizer, all under the set name', () => {
    const { leaves, synthesizeVerdictPath } = buildLeafManifest({
      worktreePath: '/wt',
      taskId: 'AISDLC-676',
      executeLeaves,
      plannerModel: 'opus',
      synthesizerModel: 'fable',
    });
    expect(leaves.map((l) => [l.stage, l.probeId])).toEqual([
      ['plan', undefined],
      ['execute', 'a'],
      ['execute', 'b'],
      ['synthesize', undefined],
    ]);
    expect(leaves.every((l) => l.reviewer === 'staged-review')).toBe(true);
    expect(leaves[0]).toMatchObject({ harness: 'claude-code', model: 'opus' });
    expect(leaves[1]).toMatchObject({ harness: 'claude-code', model: 'haiku' });
    expect(leaves[2]).toMatchObject({ harness: 'codex', model: 'codex' });
    expect(leaves[3]).toMatchObject({ model: 'fable', verdictPath: synthesizeVerdictPath });
    expect(leaves[0]!.transcriptPath.endsWith('review-planner.jsonl')).toBe(true);
    expect(leaves[3]!.transcriptPath.endsWith('review-synthesizer.jsonl')).toBe(true);
  });

  it('labels an unrouted model honestly and does not mutate its input', () => {
    const before = JSON.stringify(executeLeaves);
    const { leaves } = buildLeafManifest({ worktreePath: '/wt', taskId: 'X-1', executeLeaves });
    expect(leaves[0]!.model).toBe('unrouted');
    expect(leaves.at(-1)!.model).toBe('unrouted');
    expect(JSON.stringify(executeLeaves)).toBe(before);
  });
});
