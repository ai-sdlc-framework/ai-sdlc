import { describe, it, expect } from 'vitest';
import { DataTable, type Column } from './data-table';

describe('DataTable', () => {
  it('renders empty table', () => {
    const cols: Column<Record<string, unknown>>[] = [{ key: 'name', label: 'Name' }];
    const result = DataTable({ columns: cols, rows: [], keyField: 'name' });
    expect(result).toBeTruthy();
  });

  it('renders rows', () => {
    const cols: Column<Record<string, unknown>>[] = [
      { key: 'name', label: 'Name' },
      { key: 'value', label: 'Value', align: 'right' },
    ];
    const rows = [
      { name: 'Alpha', value: 1 },
      { name: 'Beta', value: 2 },
    ];
    const result = DataTable({ columns: cols, rows, keyField: 'name' });
    expect(result).toBeTruthy();
  });

  it('uses custom render', () => {
    const cols: Column<Record<string, unknown>>[] = [
      {
        key: 'score',
        label: 'Score',
        render: (r) => `${(r.score as number).toFixed(1)}%`,
      },
    ];
    const rows = [{ id: '1', score: 95.5 }];
    const result = DataTable({ columns: cols, rows, keyField: 'id' });
    expect(result).toBeTruthy();
  });

  it('handles missing values', () => {
    const cols: Column<Record<string, unknown>>[] = [
      { key: 'name', label: 'Name' },
      { key: 'optional', label: 'Opt' },
    ];
    const rows = [{ name: 'Test' }];
    const result = DataTable({ columns: cols, rows, keyField: 'name' });
    expect(result).toBeTruthy();
  });
});
