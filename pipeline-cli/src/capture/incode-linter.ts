/**
 * RFC-0024 §5.3 — in-code marker linter.
 *
 * Detects `// ai-sdlc:capture` markers in source files and converts them
 * to capture record fields. This replaces the unstructured `// TODO:` with
 * a triage-bearing structured marker.
 *
 * Marker syntax (TypeScript / JavaScript):
 *
 *   // ai-sdlc:capture severity=minor triage=new-issue
 *   // <finding text on subsequent comment lines>
 *
 * OQ-4 resolution: `// ai-sdlc:capture` prefix is used (not `// TODO:`)
 * to make linting unambiguous and avoid colliding with existing conventions.
 *
 * The linter is NON-BLOCKING — it surfaces findings as warnings, not errors.
 * The `pnpm lint:captures` script runs this linter across changed files in
 * a PR and surfaces markers to the capture queue.
 *
 * @module capture/incode-linter
 */

import type { CaptureSeverity, CaptureTriageValue } from './capture-record.js';
import { VALID_SEVERITIES, VALID_TRIAGE_VALUES } from './capture-record.js';

// ── Marker ────────────────────────────────────────────────────────────────────

/** The in-code marker prefix that the linter detects. */
export const INCODE_CAPTURE_MARKER = '// ai-sdlc:capture';

// ── Parsed marker ─────────────────────────────────────────────────────────────

export interface IncodeCaptureMark {
  /** File path where the marker was found. */
  filePath: string;
  /** 1-based line number of the marker line. */
  line: number;
  /** Severity parsed from `severity=<value>`. Undefined when not supplied. */
  severity?: CaptureSeverity;
  /** Triage parsed from `triage=<value>`. Undefined when not supplied. */
  triage?: CaptureTriageValue;
  /** Finding text: concatenation of subsequent comment lines until a non-comment line. */
  finding: string;
  /** Raw marker line (for diagnostics). */
  rawLine: string;
}

/**
 * Parse a single source file's content for `// ai-sdlc:capture` markers.
 *
 * Returns one `IncodeCaptureMark` per marker found. The finding text is
 * built by consuming subsequent comment lines after the marker line until
 * a non-comment line is reached.
 */
export function parseIncodeMarkers(filePath: string, content: string): IncodeCaptureMark[] {
  const lines = content.split('\n');
  const results: IncodeCaptureMark[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith(INCODE_CAPTURE_MARKER)) continue;

    // Parse attributes from the marker line.
    // Pattern: // ai-sdlc:capture severity=<value> triage=<value>
    const attrSection = trimmed.replace(/^\/\/\s*ai-sdlc:capture\s*/, '');
    let severity: CaptureSeverity | undefined;
    let triage: CaptureTriageValue | undefined;

    for (const token of attrSection.split(/\s+/)) {
      const [key, val] = token.split('=');
      if (!key || !val) continue;
      if (key === 'severity' && VALID_SEVERITIES.includes(val as CaptureSeverity)) {
        severity = val as CaptureSeverity;
      }
      if (key === 'triage' && VALID_TRIAGE_VALUES.includes(val as CaptureTriageValue)) {
        triage = val as CaptureTriageValue;
      }
    }

    // Collect subsequent comment lines as the finding.
    const findingLines: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const nextTrimmed = lines[j].trim();
      // Continuation: a comment line (but NOT another ai-sdlc:capture marker).
      if (
        (nextTrimmed.startsWith('//') || nextTrimmed.startsWith('*')) &&
        !nextTrimmed.startsWith(INCODE_CAPTURE_MARKER)
      ) {
        // Strip comment prefix and collect.
        const text = nextTrimmed
          .replace(/^\/\/+\s?/, '')
          .replace(/^\*+\s?/, '')
          .trim();
        if (text) findingLines.push(text);
        j++;
      } else {
        break;
      }
    }

    const finding = findingLines.join(' ').trim() || attrSection.trim() || '(no finding text)';

    results.push({
      filePath,
      line: i + 1,
      severity,
      triage,
      finding,
      rawLine: trimmed,
    });
  }

  return results;
}

// ── Warning formatter ─────────────────────────────────────────────────────────

/** Linter warning for one in-code marker. */
export interface IncodeMarkerWarning {
  /** Marker location. */
  location: string;
  /** Short message for the terminal. */
  message: string;
  /** The marker object. */
  mark: IncodeCaptureMark;
}

/**
 * Convert a list of in-code markers to linter warnings.
 * Warnings are non-blocking (informational) per RFC-0024 §5.3.
 */
export function markersToWarnings(marks: IncodeCaptureMark[]): IncodeMarkerWarning[] {
  return marks.map((mark) => ({
    location: `${mark.filePath}:${mark.line}`,
    message: `[ai-sdlc:capture] in-code marker found — severity=${mark.severity ?? 'unknown'} triage=${mark.triage ?? 'tbd'}: ${mark.finding}`,
    mark,
  }));
}

/**
 * Render linter warnings to a human-readable string (for terminal output).
 * Each line is prefixed with `warning:` so CI tools that scan stderr for
 * severity-keyed patterns can surface them.
 */
export function renderLinterWarnings(warnings: IncodeMarkerWarning[]): string {
  if (warnings.length === 0) return '';
  const lines = warnings.map((w) => `warning: ${w.location}: ${w.message}`);
  return lines.join('\n') + '\n';
}
