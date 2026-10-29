/**
 * CSV cell escaping shared by the usage report and scorecard renderers.
 * A cell starting with `=`, `+`, `-` or `@` is prefixed with a single quote so
 * a spreadsheet does not evaluate it as a formula; every other cell is
 * unchanged apart from standard RFC 4180 quoting.
 */
const FORMULA_LEAD = /^[=+\-@]/;

export function csvEscape(v: string): string {
  const cell = FORMULA_LEAD.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
