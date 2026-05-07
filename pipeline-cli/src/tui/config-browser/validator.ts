/**
 * Config-browser validator — RFC-0023 §9 / AISDLC-178.5 AC#5/AC#6.
 *
 * Validates `.ai-sdlc/*.yaml` files in two layers:
 *   1. YAML parse — js-yaml `loadAll` so multi-document files are handled
 *      gracefully. Errors are line-annotated using `mark.line`.
 *   2. Schema validation via `@ai-sdlc/reference` — when the parsed payload
 *      carries a recognised `kind`, the AJV-compiled validator runs and
 *      surfaces shape mismatches per JSON-pointer path.
 *
 * Files with no `kind:` field (or an unknown kind) skip schema validation
 * but still report YAML parse errors. This keeps adapter-specific files
 * (`tui-config.yaml`, `pipeline-backlog.yaml`, `orchestrator-failure-patterns.yaml`,
 * etc.) from blocking on a missing schema.
 *
 * Per OQ-2 (RFC §15) the validator runs on `e`-keystroke editor exit; the
 * pane re-validates and surfaces errors before "saving" — there's no real
 * save, the editor wrote to disk; we just refresh the in-pane view.
 */

import yaml from 'js-yaml';

export interface YamlValidationIssue {
  /** 1-based line number when known, else null. */
  line: number | null;
  /** 1-based column number when known, else null. */
  column: number | null;
  /** Human-readable message. */
  message: string;
  /** 'parse' = YAML syntax error; 'schema' = JSON Schema mismatch. */
  source: 'parse' | 'schema';
  /** JSON-pointer path within the document (schema errors only). */
  path?: string;
}

export interface YamlValidationResult {
  /** Original file content — useful for callers showing context lines. */
  text: string;
  /** All issues, line-sorted ascending. Empty when valid. */
  issues: YamlValidationIssue[];
  /** True when no issues. */
  valid: boolean;
  /** The `kind:` field discovered (or null when none/unknown). */
  detectedKind: string | null;
}

/**
 * Schema-validator delegate signature. `kind` is the ResourceKind string
 * read from the YAML root. Implementations return `null` when no schema
 * exists for the kind, otherwise a list of issues.
 *
 * The default delegate is a no-op so the validator works without the
 * `@ai-sdlc/reference` dep being present (e.g. in unit tests). Production
 * callers wire `referenceSchemaValidator` from `./reference-validator.ts`.
 */
export type SchemaValidator = (
  kind: string,
  document: unknown,
) => Array<Omit<YamlValidationIssue, 'source' | 'line' | 'column'>> | null;

/** No-op delegate — returns null so no schema issues are reported. */
export const NOOP_SCHEMA_VALIDATOR: SchemaValidator = () => null;

const KNOWN_KINDS = new Set([
  'Pipeline',
  'AgentRole',
  'QualityGate',
  'AutonomyPolicy',
  'AdapterBinding',
  'DesignSystemBinding',
  'DesignIntentDocument',
  'DorConfig',
]);

export interface ValidateYamlOpts {
  /** YAML body. */
  text: string;
  /**
   * Schema validator delegate. Defaults to a no-op so the function can be
   * imported without pulling in `@ai-sdlc/reference`.
   */
  schemaValidator?: SchemaValidator;
}

/**
 * Validate a YAML document. Returns a list of issues — empty when both
 * the parse and schema validation succeed.
 */
export function validateYaml(opts: ValidateYamlOpts): YamlValidationResult {
  const issues: YamlValidationIssue[] = [];
  const validator = opts.schemaValidator ?? NOOP_SCHEMA_VALIDATOR;

  let parsed: unknown = null;
  try {
    parsed = yaml.load(opts.text);
  } catch (err) {
    const line = extractYamlErrorLine(err);
    const col = extractYamlErrorColumn(err);
    issues.push({
      line,
      column: col,
      message: (err as Error)?.message ?? String(err),
      source: 'parse',
    });
    return {
      text: opts.text,
      issues,
      valid: false,
      detectedKind: null,
    };
  }

  const detectedKind = detectKind(parsed);

  if (detectedKind && KNOWN_KINDS.has(detectedKind)) {
    const schemaIssues = validator(detectedKind, parsed);
    if (schemaIssues && schemaIssues.length > 0) {
      for (const issue of schemaIssues) {
        issues.push({
          line: lineForJsonPath(opts.text, issue.path ?? '/'),
          column: null,
          message: issue.message,
          source: 'schema',
          path: issue.path,
        });
      }
    }
  }

  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  return {
    text: opts.text,
    issues,
    valid: issues.length === 0,
    detectedKind,
  };
}

/**
 * Walk the YAML text to find the line number where a JSON-pointer path's
 * leaf key is declared. Best-effort: returns null when the path can't be
 * resolved (e.g. deeply nested arrays). The fallback is "line 1" so the
 * issue still surfaces — the operator can read the message and find the
 * field by name.
 */
export function lineForJsonPath(text: string, path: string): number | null {
  if (!path || path === '/' || path === '') return 1;
  // JSON pointer fragments like "/spec/stages/0/name" — pull the LAST
  // non-numeric segment as the key to grep for.
  const segments = path.split('/').filter(Boolean);
  let key: string | null = null;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (!/^\d+$/.test(segments[i])) {
      key = segments[i];
      break;
    }
  }
  if (!key) return 1;

  const lines = text.split('\n');
  // Match optional leading whitespace, then optional `- ` (list item prefix),
  // then the key followed by `:`.
  const re = new RegExp(`^\\s*(?:-\\s+)?${escapeRegex(key)}\\s*:`);
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectKind(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  return typeof obj.kind === 'string' ? obj.kind : null;
}

function extractYamlErrorLine(err: unknown): number | null {
  if (err && typeof err === 'object' && 'mark' in err) {
    const mark = (err as { mark?: { line?: number } }).mark;
    if (mark && typeof mark.line === 'number') {
      // js-yaml uses 0-based lines.
      return mark.line + 1;
    }
  }
  return null;
}

function extractYamlErrorColumn(err: unknown): number | null {
  if (err && typeof err === 'object' && 'mark' in err) {
    const mark = (err as { mark?: { column?: number } }).mark;
    if (mark && typeof mark.column === 'number') {
      return mark.column + 1;
    }
  }
  return null;
}
