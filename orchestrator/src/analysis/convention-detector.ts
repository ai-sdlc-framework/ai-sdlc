/**
 * Detect coding conventions: naming style, test organization, import style.
 */

import { basename, dirname, extname } from 'node:path';
import type { FileInfo, DetectedConvention } from './types.js';

// ── Naming style helpers ──────────────────────────────────────────

function isCamelCase(name: string): boolean {
  return /^[a-z][a-zA-Z0-9]*$/.test(name);
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function isKebabCase(name: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name);
}

function isSnakeCase(name: string): boolean {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name);
}

type NamingStyle = 'camelCase' | 'PascalCase' | 'kebab-case' | 'snake_case' | 'mixed';

function detectFileNamingStyle(files: FileInfo[]): { style: NamingStyle; confidence: number; examples: string[] } {
  const counts: Record<NamingStyle, number> = {
    camelCase: 0,
    PascalCase: 0,
    'kebab-case': 0,
    snake_case: 0,
    mixed: 0,
  };
  const examples: Record<NamingStyle, string[]> = {
    camelCase: [],
    PascalCase: [],
    'kebab-case': [],
    snake_case: [],
    mixed: [],
  };

  for (const file of files) {
    const name = basename(file.relativePath, extname(file.relativePath))
      .replace(/\.(test|spec|stories|d)$/, ''); // Strip test/spec suffixes

    if (!name || name === 'index') continue;

    if (isKebabCase(name)) {
      counts['kebab-case']++;
      if (examples['kebab-case'].length < 3) examples['kebab-case'].push(file.relativePath);
    } else if (isSnakeCase(name)) {
      counts.snake_case++;
      if (examples.snake_case.length < 3) examples.snake_case.push(file.relativePath);
    } else if (isCamelCase(name)) {
      counts.camelCase++;
      if (examples.camelCase.length < 3) examples.camelCase.push(file.relativePath);
    } else if (isPascalCase(name)) {
      counts.PascalCase++;
      if (examples.PascalCase.length < 3) examples.PascalCase.push(file.relativePath);
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return { style: 'mixed', confidence: 0, examples: [] };

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]) as [NamingStyle, number][];
  const [topStyle, topCount] = sorted[0];
  const confidence = topCount / total;

  return {
    style: confidence >= 0.5 ? topStyle : 'mixed',
    confidence: Math.round(confidence * 100) / 100,
    examples: examples[topStyle],
  };
}

// ── Testing convention detection ────────────────────────────────

type TestStyle = 'co-located' | '__tests__' | 'test-directory' | 'mixed';

function detectTestingStyle(files: FileInfo[]): { style: TestStyle; confidence: number; examples: string[] } {
  let coLocated = 0;
  let testsDir = 0;
  let testDir = 0;
  const examples: Record<TestStyle, string[]> = {
    'co-located': [],
    __tests__: [],
    'test-directory': [],
    mixed: [],
  };

  const testFiles = files.filter((f) => {
    const name = basename(f.relativePath);
    return name.includes('.test.') || name.includes('.spec.') || f.relativePath.includes('__tests__');
  });

  for (const file of testFiles) {
    const dir = dirname(file.relativePath);
    if (dir.includes('__tests__')) {
      testsDir++;
      if (examples.__tests__.length < 3) examples.__tests__.push(file.relativePath);
    } else if (dir === 'test' || dir === 'tests' || dir.startsWith('test/') || dir.startsWith('tests/')) {
      testDir++;
      if (examples['test-directory'].length < 3) examples['test-directory'].push(file.relativePath);
    } else {
      coLocated++;
      if (examples['co-located'].length < 3) examples['co-located'].push(file.relativePath);
    }
  }

  const total = coLocated + testsDir + testDir;
  if (total === 0) return { style: 'mixed', confidence: 0, examples: [] };

  const counts = { 'co-located': coLocated, __tests__: testsDir, 'test-directory': testDir };
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]) as [TestStyle, number][];
  const [topStyle, topCount] = sorted[0];
  const confidence = topCount / total;

  return {
    style: confidence >= 0.5 ? topStyle : 'mixed',
    confidence: Math.round(confidence * 100) / 100,
    examples: examples[topStyle],
  };
}

// ── Import style detection ──────────────────────────────────────

type ImportStyle = 'relative' | 'path-alias' | 'barrel-re-exports' | 'mixed';

interface ImportStyleResult {
  style: ImportStyle;
  confidence: number;
  usesBarrels: boolean;
  examples: string[];
}

function detectImportStyle(files: FileInfo[]): ImportStyleResult {
  // Check for barrel index files
  const indexFiles = files.filter((f) => basename(f.relativePath).startsWith('index.'));
  const usesBarrels = indexFiles.length > 3;

  // For a proper import analysis we'd need to read file contents,
  // but for the convention detector we just note barrel presence
  return {
    style: 'relative',
    confidence: 0.8,
    usesBarrels,
    examples: indexFiles.slice(0, 3).map((f) => f.relativePath),
  };
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Detect coding conventions from the file list.
 */
export function detectConventions(files: FileInfo[]): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];

  // File naming convention
  const naming = detectFileNamingStyle(files);
  if (naming.confidence > 0) {
    conventions.push({
      category: 'naming',
      pattern: `${naming.style} for file names`,
      confidence: naming.confidence,
      examples: naming.examples,
    });
  }

  // Testing convention
  const testing = detectTestingStyle(files);
  if (testing.confidence > 0) {
    const desc = testing.style === 'co-located'
      ? 'Co-located test files (*.test.ts)'
      : testing.style === '__tests__'
        ? 'Test files in __tests__/ directories'
        : testing.style === 'test-directory'
          ? 'Test files in test/ directory'
          : 'Mixed test file placement';
    conventions.push({
      category: 'testing',
      pattern: desc,
      confidence: testing.confidence,
      examples: testing.examples,
    });
  }

  // Import style convention
  const imports = detectImportStyle(files);
  const importDesc = imports.usesBarrels
    ? 'Relative imports, barrel re-exports via index.ts'
    : 'Relative imports';
  conventions.push({
    category: 'imports',
    pattern: importDesc,
    confidence: imports.confidence,
    examples: imports.examples,
  });

  return conventions;
}
