import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeSpend,
  filterSpend,
  readSpendEvents,
  recordSpendEvent,
  renderSpendDigestBlock,
  renderSpendText,
  rungFromFrontmatter,
} from './spend.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'spend-'));
const base = { prNumber: 7, model: 'sonnet', inputTokens: 100, outputTokens: 50 };

describe('spend ledger', () => {
  it('reports developer, reviewer and judgment spend tagged by rung for one PR', () => {
    const d = tmp();
    recordSpendEvent(d, { ...base, rung: 4, agent: 'developer' });
    recordSpendEvent(d, { ...base, rung: 4, agent: 'code-reviewer' });
    recordSpendEvent(d, { ...base, rung: 2, agent: 'judgment', outcome: 'answered' });
    recordSpendEvent(d, { ...base, prNumber: 8, rung: 4, agent: 'developer' });
    const r = computeSpend(filterSpend(readSpendEvents(d), { pr: 7 }));
    expect(r.prs).toHaveLength(1);
    expect(r.prs[0]!.developerTokens).toBe(150);
    expect(r.prs[0]!.byRung).toEqual({ '2': 150, '4': 300 });
    const text = renderSpendText(r, true);
    expect(text).toContain('developer round: 150');
    expect(text).toContain('rung 2 judgment');
  });

  it('links the rung-3 call to the escalated rung-2 call', () => {
    const d = tmp();
    const two = recordSpendEvent(d, { ...base, rung: 2, agent: 'judgment', outcome: 'escalated' });
    const three = recordSpendEvent(d, { ...base, rung: 3, agent: 'review-executor' });
    expect(three.linkedTo).toBe(two.id);
    const text = renderSpendText(computeSpend(readSpendEvents(d)), true);
    expect(text).toContain('outcome: escalated');
    expect(text).toContain(`follows ${two.id}`);
    // a second rung-3 call is not linked again
    expect(recordSpendEvent(d, { ...base, rung: 3, agent: 'x' }).linkedTo).toBeUndefined();
  });

  it('never caps or refuses spend, however large', () => {
    const d = tmp();
    const e = recordSpendEvent(d, { ...base, rung: 4, agent: 'developer', inputTokens: 1e12 });
    expect(e.inputTokens).toBe(1e12);
    expect(computeSpend(readSpendEvents(d)).prs[0]!.totalTokens).toBe(1e12 + 50);
  });

  it('computes distributions and the digest block, and handles empty input', () => {
    expect(renderSpendText(computeSpend([]), false)).toContain('No spend');
    expect(renderSpendDigestBlock([], 'x')).toContain('None.');
    const d = tmp();
    for (let pr = 1; pr <= 7; pr++) {
      recordSpendEvent(d, { ...base, prNumber: pr, rung: 4, agent: 'developer', inputTokens: pr });
    }
    const ev = readSpendEvents(d);
    const r = computeSpend(ev);
    expect(r.total.max).toBe(57);
    expect(r.total.median).toBe(54);
    const block = renderSpendDigestBlock(ev, 'since');
    expect(block.match(/^- #/gm)).toHaveLength(5);
    expect(renderSpendText(r, false)).toContain('p90');
    expect(filterSpend(ev, { since: '2999-01-01' })).toEqual([]);
  });

  it('reads rung from agent frontmatter', () => {
    const d = tmp();
    mkdirSync(join(d, 'ai-sdlc-plugin', 'agents'), { recursive: true });
    writeFileSync(join(d, 'ai-sdlc-plugin', 'agents', 'a.md'), '---\nname: a\nrung: 3\n---\nx');
    expect(rungFromFrontmatter(d, 'a')).toBe(3);
    expect(rungFromFrontmatter(d, 'missing')).toBeUndefined();
  });
});
