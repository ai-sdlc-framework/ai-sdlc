import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRoutingTable } from './load-table.js';
import { SECURITY_REVIEWER_ROLE } from './default-table.js';

const TABLE_PATH = resolve(import.meta.dirname, '../../../.ai-sdlc/model-routing.yaml');

describe('committed .ai-sdlc/model-routing.yaml', () => {
  const parsed = parseRoutingTable(readFileSync(TABLE_PATH, 'utf-8'));

  it('parses with parseRoutingTable', () => {
    expect(parsed.ok).toBe(true);
  });

  it('names only models listed in strength', () => {
    if (!parsed.ok) throw new Error(parsed.reason);
    const known = new Set(parsed.table.strength);
    for (const byClass of Object.values(parsed.table.cells)) {
      for (const cell of Object.values(byClass)) {
        expect(known.has(cell.model)).toBe(true);
      }
    }
  });

  it('puts the security reviewer on the strongest entry', () => {
    if (!parsed.ok) throw new Error(parsed.reason);
    const strongest = parsed.table.strength[parsed.table.strength.length - 1];
    const cells = Object.values(parsed.table.cells[SECURITY_REVIEWER_ROLE]);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.model).toBe(strongest);
  });
});
