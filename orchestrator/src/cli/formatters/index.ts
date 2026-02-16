/**
 * Output formatter factory — routes to table, json, or minimal.
 */

import { formatTable } from './table.js';
import { formatJson } from './json.js';
import { formatMinimal } from './minimal.js';

export type FormatType = 'table' | 'json' | 'minimal';

export function formatOutput(format: string, data: Record<string, unknown>): string {
  switch (format) {
    case 'json':
      return formatJson(data);
    case 'minimal':
      return formatMinimal(data);
    case 'table':
    default:
      return formatTable(data);
  }
}
