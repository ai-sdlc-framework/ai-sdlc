/**
 * Diff analyzer — runs deterministic structural checks on changed files
 * BEFORE LLM review agents see the diff.
 *
 * Reuses existing analysis infrastructure:
 * - parseImports() for import counting
 * - computeFileComplexity() for per-file complexity scoring
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseImports } from './dependency-parser.js';
import { computeFileComplexity } from './hotspot-analyzer.js';

// ── Types ────────────────────────────────────────────────────────────

export interface DiffFinding {
  type: 'complexity' | 'imports' | 'file-length';
  file: string;
  severity: 'info' | 'warning';
  message: string;
}

export interface DiffAnalysisResult {
  /** Files touched by the diff. */
  changedFiles: string[];
  /** Deterministic structural findings. */
  findings: DiffFinding[];
  /** Formatted summary for injection into review agent context. */
  summary: string;
}

// ── Thresholds ───────────────────────────────────────────────────────

const COMPLEXITY_THRESHOLD = 7;
const FILE_LENGTH_THRESHOLD = 300;
const IMPORT_COUNT_THRESHOLD = 15;

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
]);

// ── Diff parsing ─────────────────────────────────────────────────────

/**
 * Extract changed file paths from a unified diff.
 * Parses `--- a/path` and `+++ b/path` lines.
 */
export function extractChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = line.match(/^[+-]{3}\s[ab]\/(.+)$/);
    if (match && match[1] !== '/dev/null') {
      files.add(match[1]);
    }
  }
  return [...files];
}

// ── Analysis ─────────────────────────────────────────────────────────

/**
 * Analyze a PR diff for structural issues.
 * Returns deterministic findings that review agents can skip.
 */
export async function analyzeDiff(diff: string, repoPath: string): Promise<DiffAnalysisResult> {
  const changedFiles = extractChangedFiles(diff);
  const findings: DiffFinding[] = [];

  // Only analyze code files that exist on disk (skip deleted files)
  const codeFiles = changedFiles.filter((f) => {
    const ext = '.' + f.split('.').pop();
    return CODE_EXTENSIONS.has(ext) && existsSync(join(repoPath, f));
  });

  for (const file of codeFiles) {
    const fullPath = join(repoPath, file);

    // Read file for line count
    let content: string;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lineCount = content.split('\n').length;

    // Parse imports
    const imports = await parseImports(fullPath);
    const importCount = imports.length;

    // Check 1: File complexity
    const complexity = computeFileComplexity(lineCount, importCount);
    if (complexity >= COMPLEXITY_THRESHOLD) {
      findings.push({
        type: 'complexity',
        file,
        severity: 'warning',
        message: `High complexity (${complexity}/10) — ${lineCount} lines, ${importCount} imports. Review with extra care.`,
      });
    }

    // Check 2: Large file
    if (lineCount > FILE_LENGTH_THRESHOLD) {
      findings.push({
        type: 'file-length',
        file,
        severity: lineCount > 500 ? 'warning' : 'info',
        message: `Large file (${lineCount} lines). Consider splitting if it has multiple responsibilities.`,
      });
    }

    // Check 3: High import count (coupling)
    if (importCount >= IMPORT_COUNT_THRESHOLD) {
      findings.push({
        type: 'imports',
        file,
        severity: 'warning',
        message: `High coupling (${importCount} imports). May indicate the file has too many responsibilities.`,
      });
    }
  }

  const summary = formatSummary(changedFiles, codeFiles, findings);

  return { changedFiles, findings, summary };
}

// ── Formatting ───────────────────────────────────────────────────────

function formatSummary(allFiles: string[], codeFiles: string[], findings: DiffFinding[]): string {
  if (findings.length === 0) {
    return `## Pre-Verified Structural Analysis\n\nAnalyzed ${codeFiles.length} code files (${allFiles.length} total changed). No structural issues found.`;
  }

  const lines = [
    `## Pre-Verified Structural Analysis`,
    '',
    `Analyzed ${codeFiles.length} code files (${allFiles.length} total changed). ${findings.length} structural finding(s):`,
    '',
  ];

  for (const f of findings) {
    const icon = f.severity === 'warning' ? '⚠️' : 'ℹ️';
    lines.push(`- ${icon} **${f.file}**: ${f.message}`);
  }

  lines.push('');
  lines.push(
    '*These findings are deterministic. Do NOT re-analyze these files for the issues above.*',
  );

  return lines.join('\n');
}
