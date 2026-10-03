/**
 * Stage 0 of the staged review: facts code can compute from the diff alone, with
 * no model and no dependency graph. Diff statistics, file classes by path, the
 * changed tests that exercise each changed source file, a secret-pattern scan
 * through `redactSecrets`, and dependency-manifest and workflow change flags.
 *
 * @module review-risk-map/stage0
 */

import { redactSecrets } from '@ai-sdlc/reference';
import { isCiPath, isDocsLikePath, isLockfilePath } from '../classifier/classifier.js';
import type { FileClass } from '../review-plan/types.js';
import { parseDiff, UNPARSEABLE_PATH } from './diff.js';

const MANIFEST_RE =
  /(?:^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Pipfile|Gemfile|composer\.json|pom\.xml|build\.gradle(?:\.kts)?)$/i;
const MIGRATION_RE = /(?:^|\/)(?:migrations?|db\/migrate)\//i;
const TEST_RE =
  /(?:[._]test|[._]spec)\.[A-Za-z0-9]+$|(?:^|\/)(?:__tests__|tests?)\/|_test\.(?:go|py)$|(?:^|\/)test_[^/]+\.py$/i;
const CONFIG_RE = /\.(?:json|ya?ml|toml|ini|cfg|conf)$|(?:^|\/)\.[A-Za-z0-9_.-]+rc(?:\.[a-z]+)?$/i;
const MARKER_RE = /\[REDACTED:[A-Za-z0-9_-]+\]/g;

/** File class by path, using the review classifier's path rules where they exist. */
export function classifyFile(path: string): FileClass {
  if (isCiPath(path)) return 'workflow';
  if (MANIFEST_RE.test(path)) return 'manifest';
  if (isLockfilePath(path)) return 'lockfile';
  if (MIGRATION_RE.test(path)) return 'migration';
  if (isDocsLikePath(path)) return 'docs';
  if (TEST_RE.test(path)) return 'test';
  if (CONFIG_RE.test(path)) return 'config';
  return 'source';
}

function stem(path: string, isTest: boolean): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  let s = base.replace(/\.[A-Za-z0-9]+$/, '');
  if (isTest) s = s.replace(/[._](?:test|spec)$/i, '').replace(/^test_/i, '');
  return s.toLowerCase();
}

/** Changed test files whose name matches the source file's name. */
export function matchChangedTests(sourcePath: string, testFiles: readonly string[]): string[] {
  const want = stem(sourcePath, false);
  return testFiles.filter((t) => stem(t, true) === want);
}

export interface Stage0Hunk {
  id: string;
  file: string;
  fileClass: FileClass;
  header: string;
  startLine: number;
  endLine: number;
  /** Hunk body with secrets already redacted. Empty for a placeholder hunk. */
  text: string;
  secretMarkers: string[];
  /** True for a placeholder standing in for a file with no textual hunk. */
  synthetic: boolean;
}

export interface Stage0File {
  path: string;
  fileClass: FileClass;
  /** Changed test files whose name matches this file. */
  nameMatchedTests: string[];
}

export interface Stage0Facts {
  stats: {
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    hunks: number;
    unparseableHeaders: number;
  };
  flags: {
    dependencyManifestChanged: boolean;
    workflowChanged: boolean;
    secretsFound: boolean;
  };
  files: Stage0File[];
  hunks: Stage0Hunk[];
  changedFiles: string[];
  changedTestFiles: string[];
}

export function runStage0(diff: string): Stage0Facts {
  const parsed = parseDiff(diff);
  const classOf = new Map<string, FileClass>();
  const changedFiles: string[] = [];
  for (const f of parsed) {
    if (classOf.has(f.path)) continue;
    classOf.set(f.path, f.unparseable ? 'source' : classifyFile(f.path));
    changedFiles.push(f.path);
  }
  const changedTestFiles = changedFiles.filter((p) => classOf.get(p) === 'test');

  const files: Stage0File[] = changedFiles.map((path) => {
    const fileClass = classOf.get(path) ?? 'source';
    return {
      path,
      fileClass,
      nameMatchedTests: fileClass === 'source' ? matchChangedTests(path, changedTestFiles) : [],
    };
  });

  const hunks: Stage0Hunk[] = [];
  let n = 0;
  for (const f of parsed) {
    for (const h of f.hunks) {
      n++;
      const raw = `${h.header}\n${h.text}`;
      const redacted = redactSecrets(raw);
      const markers = redacted === raw ? [] : [...new Set(redacted.match(MARKER_RE) ?? [])].sort();
      const nl = redacted.indexOf('\n');
      hunks.push({
        id: `h${n}`,
        file: f.path,
        fileClass: classOf.get(f.path) ?? 'source',
        header: nl < 0 ? redacted : redacted.slice(0, nl),
        startLine: h.startLine,
        endLine: h.endLine,
        text: h.synthetic ? '' : nl < 0 ? '' : redacted.slice(nl + 1),
        secretMarkers: markers,
        synthetic: h.synthetic,
      });
    }
  }

  const classes = new Set(classOf.values());
  return {
    stats: {
      filesChanged: parsed.length,
      linesAdded: parsed.reduce((a, f) => a + f.added, 0),
      linesRemoved: parsed.reduce((a, f) => a + f.removed, 0),
      hunks: hunks.length,
      unparseableHeaders: parsed.filter((f) => f.unparseable || f.path === UNPARSEABLE_PATH).length,
    },
    flags: {
      dependencyManifestChanged: classes.has('manifest') || classes.has('lockfile'),
      workflowChanged: classes.has('workflow'),
      secretsFound: hunks.some((h) => h.secretMarkers.length > 0),
    },
    files,
    hunks,
    changedFiles,
    changedTestFiles,
  };
}
