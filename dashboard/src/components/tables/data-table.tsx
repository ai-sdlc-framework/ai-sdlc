/**
 * Generic sortable data table.
 */

export interface Column<T> {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  render?: (row: T) => string | number;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  keyField: string;
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  keyField,
}: DataTableProps<T>) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
          {columns.map((col) => (
            <th
              key={col.key}
              style={{
                textAlign: col.align ?? 'left',
                padding: '8px 12px',
                color: '#475569',
                fontWeight: 600,
              }}
            >
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[keyField])} style={{ borderBottom: '1px solid #f1f5f9' }}>
            {columns.map((col) => {
              const value = col.render ? col.render(row) : String(row[col.key] ?? '');
              return (
                <td
                  key={col.key}
                  style={{
                    textAlign: col.align ?? 'left',
                    padding: '8px 12px',
                    color: '#334155',
                  }}
                >
                  {value}
                </td>
              );
            })}
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td
              colSpan={columns.length}
              style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}
            >
              No data available.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
