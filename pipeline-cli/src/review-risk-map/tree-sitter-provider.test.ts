import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit, type GitRunner } from '../review-plan/executor-git.js';
import {
  executePlan,
  type ExecutorLimits,
  type ProbeSpawner,
  type ProbeSpawnOpts,
  type ReviewPlan,
} from '../review-plan/index.js';
import {
  buildRiskMap,
  createTreeSitterDependencyQuery,
  isTestPath,
  languageForPath,
  TreeSitterStructuralProvider,
  type FileAnalysis,
  type TreeSitterProviderOptions,
} from './index.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const SECRET = 'LOCAL_ONLY_DO_NOT_READ';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) removeFixtureDir(r);
});

interface Repo {
  dir: string;
  commit: string;
}

/** A real git repository with the given files committed, plus an ignored `.env`. */
function makeRepo(files: Record<string, string>, untracked: Record<string, string> = {}): Repo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rp-ts-')));
  roots.push(dir);
  const git = (...a: string[]): string =>
    execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  const put = (rel: string, body: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  put('.gitignore', '.env\n');
  for (const [rel, body] of Object.entries(files)) put(rel, body);
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  // Written after the commit: present in the working tree, never in the commit.
  put('.env', `API_KEY=${SECRET}\nlogin=${SECRET}\n`);
  for (const [rel, body] of Object.entries(untracked)) put(rel, body);
  return { dir, commit: git('rev-parse', 'HEAD').trim() };
}

const lineOf = (src: string, needle: string): number =>
  src.split('\n').findIndex((l) => l.includes(needle)) + 1;

// ── Fixtures ─────────────────────────────────────────────────────────────

const TS_AUTH = `import { hash } from './crypto.js';
import { audit } from './audit.js';

export function login(user: string, pw: string): boolean {
  audit(user);
  return hash(pw) === 'x';
}

export const MAX_TRIES = 3;

export class Session {
  start(user: string): boolean {
    return login(user, 'p');
  }
}
`;

const TS_FILES: Record<string, string> = {
  'src/auth.ts': TS_AUTH,
  'src/crypto.ts': 'export function hash(s: string): string {\n  return s;\n}\n',
  'src/audit.ts': 'export function audit(u: string): void {\n  console.log(u);\n}\n',
  'src/app.ts':
    "import { login } from './auth.js';\n\nexport function main(): boolean {\n  return login('a', 'b');\n}\n",
  'src/auth.test.ts':
    "import { login } from './auth.js';\n\nit('logs in', () => {\n  login('a', 'b');\n});\n",
  'src/unrelated.ts': 'export function other(): number {\n  return 1;\n}\n',
};

const PY_FILES: Record<string, string> = {
  'pkg/auth.py':
    'from pkg.crypto import hash_pw\nfrom pkg.audit import audit\n\n\ndef login(user):\n    audit(user)\n    return hash_pw(user)\n',
  'pkg/crypto.py': 'def hash_pw(s):\n    return s\n',
  'pkg/audit.py': 'def audit(u):\n    print(u)\n',
  'pkg/app.py': 'from pkg.auth import login\n\n\ndef main():\n    return login("a")\n',
  'tests/test_auth.py':
    'from pkg.auth import login\n\n\ndef test_login():\n    assert login("a")\n',
};

const GO_FILES: Record<string, string> = {
  'auth/auth.go':
    'package auth\n\nfunc Login(user string) bool {\n\tAudit(user)\n\treturn Hash(user) == "x"\n}\n',
  'auth/crypto.go': 'package auth\n\nfunc Hash(s string) string {\n\treturn s\n}\n',
  'auth/audit.go': 'package auth\n\nfunc Audit(u string) {\n}\n',
  'auth/app.go': 'package auth\n\nfunc Main() bool {\n\treturn Login("a")\n}\n',
  'auth/auth_test.go':
    'package auth\n\nimport "testing"\n\nfunc TestLogin(t *testing.T) {\n\tLogin("a")\n}\n',
};

function provider(repo: Repo, extra: Partial<TreeSitterProviderOptions> = {}) {
  return new TreeSitterStructuralProvider({ repoRoot: repo.dir, commit: repo.commit, ...extra });
}

async function one(
  p: TreeSitterStructuralProvider,
  file: string,
  start?: number,
  end?: number,
): Promise<FileAnalysis> {
  const [a] = await p.analyzeChanges([
    { file, ...(start !== undefined ? { ranges: [{ start, end: end ?? start }] } : {}) },
  ]);
  return a!;
}

function available(a: FileAnalysis) {
  if (a.status !== 'available') throw new Error(`unavailable: ${a.reason}`);
  return a.symbols;
}

describe('language helpers', () => {
  it('maps extensions to grammars and recognises test paths', () => {
    expect(languageForPath('a/b.tsx')?.grammar).toBe('tsx');
    expect(languageForPath('a/b.MJS')?.family).toBe('ecmascript');
    expect(languageForPath('x.py')?.family).toBe('python');
    expect(languageForPath('x.rs')).toBeUndefined();
    expect(languageForPath('Makefile')).toBeUndefined();
    for (const t of [
      'src/a.test.ts',
      'src/a.spec.jsx',
      'tests/x.py',
      'pkg/test_x.py',
      'pkg/x_test.py',
      'auth/auth_test.go',
      'src/__tests__/a.ts',
    ]) {
      expect(isTestPath(t)).toBe(true);
    }
    for (const t of ['src/auth.ts', 'pkg/auth.py', 'auth/auth.go', 'src/contest.ts']) {
      expect(isTestPath(t)).toBe(false);
    }
  });
});

describe('TreeSitterStructuralProvider: callers, callees and tests', () => {
  it('TypeScript: a changed function has callers, callees and a referencing test', async () => {
    const repo = makeRepo(TS_FILES);
    const p = provider(repo);
    const line = lineOf(TS_AUTH, 'audit(user);');
    const [s] = available(await one(p, 'src/auth.ts', line, line));
    expect(s).toMatchObject({ name: 'login', kind: 'function', startLine: 4, endLine: 7 });
    expect(s!.callers).toEqual(['src/app.ts#main', 'src/auth.ts#Session.start']);
    expect(s!.callees).toEqual(['src/audit.ts#audit', 'src/crypto.ts#hash']);
    expect(s!.referencingTests).toEqual(['src/auth.test.ts']);
    expect(s!.truncated).toEqual([]);
  });

  it('Python: a changed function has callers, callees and a referencing test', async () => {
    const repo = makeRepo(PY_FILES);
    const [s] = available(await one(provider(repo), 'pkg/auth.py', 6, 6));
    expect(s).toMatchObject({ name: 'login', kind: 'function' });
    expect(s!.callers).toEqual(['pkg/app.py#main']);
    expect(s!.callees).toEqual(['pkg/audit.py#audit', 'pkg/crypto.py#hash_pw']);
    expect(s!.referencingTests).toEqual(['tests/test_auth.py']);
  });

  it('Go: a changed function has callers, callees and a referencing test', async () => {
    const repo = makeRepo(GO_FILES);
    const [s] = available(await one(provider(repo), 'auth/auth.go', 4, 4));
    expect(s).toMatchObject({ name: 'Login', kind: 'function' });
    expect(s!.callers).toEqual(['auth/app.go#Main']);
    expect(s!.callees).toEqual(['auth/audit.go#Audit', 'auth/crypto.go#Hash']);
    expect(s!.referencingTests).toEqual(['auth/auth_test.go']);
  });

  it('reports a change inside a method as the method, not its class', async () => {
    const repo = makeRepo(TS_FILES);
    const line = lineOf(TS_AUTH, "return login(user, 'p');");
    const symbols = available(await one(provider(repo), 'src/auth.ts', line, line));
    expect(symbols.map((s) => s.qualified)).toEqual(['Session.start']);
    expect(symbols[0]!.kind).toBe('method');
    expect(symbols[0]!.callees).toEqual(['src/auth.ts#login']);
  });

  it('reports an exported constant, and nothing for a change outside any declaration', async () => {
    const repo = makeRepo(TS_FILES);
    const constLine = lineOf(TS_AUTH, 'MAX_TRIES');
    const [c] = available(await one(provider(repo), 'src/auth.ts', constLine, constLine));
    expect(c).toMatchObject({ name: 'MAX_TRIES', kind: 'const' });
    expect(available(await one(provider(repo), 'src/auth.ts', 1, 1))).toEqual([]);
  });

  it('lists every declaration when no range is given, and filters by name', async () => {
    const repo = makeRepo({
      ...TS_FILES,
      'src/shapes.ts': [
        'export class Shape {',
        '  area = () => this.compute();',
        '  compute() { return new Helper().run(); }',
        '}',
        'const local = function () { return 1; };',
        'const plain = 5;',
        'export const handler = async () => local();',
        '',
      ].join('\n'),
    });
    const all = available(await one(provider(repo), 'src/shapes.ts'));
    expect(all.map((s) => `${s.kind}:${s.qualified}`)).toEqual([
      'class:Shape',
      'method:Shape.area',
      'method:Shape.compute',
      'function:local',
      'function:handler',
    ]);
    const compute = all.find((s) => s.name === 'compute')!;
    expect(compute.callees).toEqual(['Helper', 'run']);
    const [named] = await provider(repo).analyzeChanges([
      { file: 'src/shapes.ts', names: ['handler'] },
    ]);
    expect(available(named!).map((s) => s.name)).toEqual(['handler']);
  });

  it('extracts Python classes, methods, module constants and Go types, methods and constants', async () => {
    const repo = makeRepo({
      'pkg/models.py':
        'LIMIT = 3\nx, y = 1, 2\n\n\nclass Repo:\n    @staticmethod\n    def load(name):\n        def inner():\n            return name\n        return inner()\n',
      'srv/server.go':
        'package srv\n\nconst Version = "1"\nconst private = 2\n\ntype Server struct{}\n\nfunc (s *Server) Start() {\n\ts.run()\n}\n\nfunc (Server) Stop() {}\n',
    });
    const py = available(await one(provider(repo), 'pkg/models.py'));
    expect(py.map((s) => `${s.kind}:${s.qualified}`)).toEqual([
      'const:LIMIT',
      'class:Repo',
      'method:Repo.load',
      'function:inner',
    ]);
    const go = available(await one(provider(repo), 'srv/server.go'));
    expect(go.map((s) => `${s.kind}:${s.qualified}`)).toEqual([
      'const:Version',
      'class:Server',
      'method:Server.Start',
      'method:Server.Stop',
    ]);
    expect(go.find((s) => s.name === 'Start')!.callees).toEqual(['run']);
  });

  it('does not count a symbol calling itself as its own caller', async () => {
    const repo = makeRepo({
      'src/rec.ts': 'export function walk(n: number): number {\n  return n ? walk(n - 1) : 0;\n}\n',
    });
    const [s] = available(await one(provider(repo), 'src/rec.ts', 2, 2));
    expect(s!.callers).toEqual([]);
    expect(s!.callees).toEqual([]);
  });

  it('factsFor maps a hunk to the facts the risk map consumes', async () => {
    const repo = makeRepo(TS_FILES);
    const facts = await provider(repo).factsFor({
      id: 'h1',
      file: 'src/auth.ts',
      fileClass: 'source',
      startLine: 5,
      endLine: 6,
      text: '',
    });
    expect(facts).toEqual({
      symbols: ['login'],
      callers: ['src/app.ts#main', 'src/auth.ts#Session.start'],
      callees: ['src/audit.ts#audit', 'src/crypto.ts#hash'],
      referencingTests: ['src/auth.test.ts'],
      coverageLines: [],
      schemaConsumers: [],
    });
  });
});

describe('TreeSitterStructuralProvider: unavailable, each for a distinct reason', () => {
  const extra: Record<string, string> = {
    'notes.md': '# notes\n',
    'lib.rs': 'fn main() {}\n',
    'src/broken.ts': 'export function broken( {{{ login(;;\n',
    'src/big.ts': `export const big = '${'x'.repeat(3000)}';\n`,
  };

  it('a language with no grammar is unavailable with no-grammar, and does not fail the risk map', async () => {
    const repo = makeRepo({ ...TS_FILES, ...extra });
    const p = provider(repo);
    for (const f of ['notes.md', 'lib.rs']) {
      expect(await one(p, f, 1, 1)).toEqual({
        file: f,
        status: 'unavailable',
        reason: 'no-grammar',
      });
    }
    // A grammar that is not installed (or does not load) behaves the same way.
    const missing = provider(makeRepo(PY_FILES), {
      grammarPaths: { python: '/nonexistent/tree-sitter-python.wasm' },
    });
    expect(await one(missing, 'pkg/auth.py', 6, 6)).toMatchObject({ reason: 'no-grammar' });
    const unset = provider(makeRepo(PY_FILES), { grammarPaths: { python: '' } });
    expect(await one(unset, 'pkg/auth.py', 6, 6)).toMatchObject({ reason: 'no-grammar' });

    const diff = [
      'diff --git a/notes.md b/notes.md',
      'index 111..222 100644',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,1 +1,2 @@',
      ' # notes',
      '+more',
      '',
    ].join('\n');
    const out = join(repo.dir, '_artifacts');
    const { map } = await buildRiskMap(diff, { structural: p, artifactsDir: out, runId: 'md' });
    expect(map.hunks[0]!.structural).toEqual({ status: 'unavailable' });
    expect(map.hunks[0]!.riskScore).toBe(1);
  });

  it('a file over the byte cap is file-too-large', async () => {
    const repo = makeRepo({ ...TS_FILES, ...extra });
    const p = provider(repo, { limits: { maxBytesPerFile: 2000 } });
    expect(await one(p, 'src/big.ts', 1, 1)).toEqual({
      file: 'src/big.ts',
      status: 'unavailable',
      reason: 'file-too-large',
    });
  });

  it('a syntax error is parse-error, and a broken candidate file is skipped and recorded', async () => {
    const repo = makeRepo({ ...TS_FILES, ...extra });
    const p = provider(repo);
    expect(await one(p, 'src/broken.ts', 1, 1)).toMatchObject({ reason: 'parse-error' });
    const [s] = available(await one(p, 'src/auth.ts', 5, 5));
    expect(s!.callers).toEqual(['src/app.ts#main', 'src/auth.ts#Session.start']);
    expect(p.report().skippedCandidates).toContainEqual({
      file: 'src/broken.ts',
      reason: 'parse-error',
    });
    expect(p.report().files['src/broken.ts']).toEqual({
      status: 'unavailable',
      reason: 'parse-error',
    });
    expect(p.report().files['src/auth.ts']).toEqual({ status: 'available' });
  });

  it('an exceeded wall-clock budget is budget-exceeded', async () => {
    const repo = makeRepo(TS_FILES);
    const p = provider(repo, { limits: { parseBudgetMs: 0 } });
    expect(await one(p, 'src/auth.ts', 5, 5)).toEqual({
      file: 'src/auth.ts',
      status: 'unavailable',
      reason: 'budget-exceeded',
    });
    // The budget cut is not cached: a provider with room parses the same file.
    expect(available(await one(provider(repo), 'src/auth.ts', 5, 5))).toHaveLength(1);
  });

  it('a budget that runs out mid-way skips the remaining candidates', async () => {
    const repo = makeRepo(TS_FILES);
    let clock = 0;
    // The changed file parses inside the budget; the budget is spent by the time candidates are read.
    const spendBudget: GitRunner = async (args, opts) => {
      const r = await runGit(args, opts);
      if (args[0] === 'grep') clock = 100;
      return r;
    };
    const p = provider(repo, {
      limits: { parseBudgetMs: 50 },
      now: () => clock,
      git: spendBudget,
    });
    const [s] = available(await one(p, 'src/auth.ts', 5, 5));
    expect(s!.callers).toEqual(['src/auth.ts#Session.start']);
    const skipped = p.report().skippedCandidates;
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((c) => c.reason === 'budget-exceeded')).toBe(true);
  });

  it('the files-parsed cap is file-cap for a changed file and a recorded truncation for callers', async () => {
    const repo = makeRepo(TS_FILES);
    const p = provider(repo, { limits: { maxFilesParsed: 1 } });
    const [a, b] = await p.analyzeChanges([
      { file: 'src/auth.ts', ranges: [{ start: 5, end: 5 }] },
      { file: 'src/crypto.ts', ranges: [{ start: 1, end: 1 }] },
    ]);
    expect(available(a!)[0]!.callers).toEqual(['src/auth.ts#Session.start']);
    expect(b).toEqual({ file: 'src/crypto.ts', status: 'unavailable', reason: 'file-cap' });
    expect(p.report().truncations).toContain('files-parsed-cap');
    expect(p.report().skippedCandidates.some((c) => c.reason === 'file-cap')).toBe(true);
  });

  it('the per-symbol result cap is recorded as a truncation marker', async () => {
    const repo = makeRepo(TS_FILES);
    const p = provider(repo, { limits: { maxResultsPerSymbol: 1 } });
    const [s] = available(await one(p, 'src/auth.ts', 5, 5));
    expect(s!.callers).toHaveLength(1);
    expect(s!.callees).toHaveLength(1);
    expect(s!.truncated).toEqual(['callers', 'callees']);
    expect(p.report().truncations).toEqual(
      expect.arrayContaining(['callers-truncated:login', 'callees-truncated:login']),
    );
  });

  it('git failures are git-error and never throw', async () => {
    const repo = makeRepo(TS_FILES);
    const throwing: GitRunner = () => Promise.reject(new Error('no git'));
    expect(await one(provider(repo, { git: throwing }), 'src/auth.ts', 5, 5)).toMatchObject({
      reason: 'git-error',
    });
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'rp-ts-none-')));
    roots.push(notRepo);
    const none = new TreeSitterStructuralProvider({ repoRoot: notRepo });
    expect(await one(none, 'a.ts', 1, 1)).toMatchObject({ reason: 'git-error' });
    expect(
      await none.factsFor({
        id: 'h',
        file: 'a.ts',
        fileClass: 'source',
        startLine: 1,
        endLine: 1,
        text: '',
      }),
    ).toBeUndefined();

    const truncatedTree: GitRunner = async (args, opts) => {
      const r = await runGit(args, opts);
      return args[0] === 'ls-tree' ? { ...r, truncated: true } : r;
    };
    expect(await one(provider(repo, { git: truncatedTree }), 'src/auth.ts', 5, 5)).toMatchObject({
      reason: 'git-error',
    });

    const badGrep: GitRunner = async (args, opts) =>
      args[0] === 'grep'
        ? Promise.reject(Object.assign(new Error('bad'), { code: 2 }))
        : runGit(args, opts);
    expect(await one(provider(repo, { git: badGrep }), 'src/auth.ts', 5, 5)).toMatchObject({
      reason: 'git-error',
    });

    const badBlob: GitRunner = async (args, opts) =>
      args[0] === 'cat-file' ? Promise.reject(new Error('gone')) : runGit(args, opts);
    expect(await one(provider(repo, { git: badBlob }), 'src/auth.ts', 5, 5)).toMatchObject({
      reason: 'git-error',
    });

    const cutBlob: GitRunner = async (args, opts) => {
      const r = await runGit(args, opts);
      return args[0] === 'cat-file' ? { ...r, truncated: true } : r;
    };
    expect(await one(provider(repo, { git: cutBlob }), 'src/auth.ts', 5, 5)).toMatchObject({
      reason: 'file-too-large',
    });

    const cutGrep: GitRunner = async (args, opts) => {
      const r = await runGit(args, opts);
      return args[0] === 'grep' ? { ...r, truncated: true } : r;
    };
    const cp = provider(repo, { git: cutGrep });
    available(await one(cp, 'src/auth.ts', 5, 5));
    expect(cp.report().truncations).toContain('grep-output-cap');
  });

  it('an unresolvable commit is git-error', async () => {
    const repo = makeRepo(TS_FILES);
    const p = new TreeSitterStructuralProvider({ repoRoot: repo.dir, commit: 'not-a-sha' });
    expect(await one(p, 'src/auth.ts', 5, 5)).toMatchObject({ reason: 'git-error' });
  });

  it('resolves HEAD when no commit is given', async () => {
    const repo = makeRepo(TS_FILES);
    const p = new TreeSitterStructuralProvider({ repoRoot: repo.dir });
    expect(available(await one(p, 'src/auth.ts', 5, 5))).toHaveLength(1);
  });
});

describe('TreeSitterStructuralProvider: only tracked files are read', () => {
  it('never reads a gitignored .env or an untracked source file', async () => {
    const repo = makeRepo(TS_FILES, {
      'src/local.ts':
        "import { login } from './auth.js';\nexport function sneaky() { login('a', 'b'); }\n",
    });
    const reads: string[] = [];
    const spy: GitRunner = async (args, opts) => {
      const r = await runGit(args, opts);
      reads.push(r.stdout.toString('utf8'));
      return r;
    };
    const p = provider(repo, { git: spy });

    expect(await one(p, '.env', 1, 1)).toEqual({
      file: '.env',
      status: 'unavailable',
      reason: 'not-tracked',
    });
    expect(await one(p, 'src/local.ts', 2, 2)).toMatchObject({ reason: 'not-tracked' });

    const [s] = available(await one(p, 'src/auth.ts', 5, 5));
    expect(s!.callers).not.toContain('src/local.ts#sneaky');
    const text = await p.queryDependencies({ symbols: ['login'], files: ['.env', 'src/auth.ts'] });
    expect(text).toContain('.env: unavailable (not-tracked)');
    expect(text).not.toContain('sneaky');
    expect(text).not.toContain(SECRET);
    expect(reads.join('\n')).not.toContain(SECRET);
    expect(reads.join('\n')).not.toContain('sneaky');
  });
});

describe('dependency query for the trace probe', () => {
  it('renders callers, callees and tests, found by file or by symbol', async () => {
    const repo = makeRepo(TS_FILES);
    const byFile = await provider(repo).queryDependencies({
      symbols: ['login'],
      files: ['src/auth.ts'],
    });
    expect(byFile).toContain('symbol login (function, src/auth.ts:4-7)');
    expect(byFile).toContain('    src/app.ts#main');
    expect(byFile).toContain('    src/crypto.ts#hash');
    expect(byFile).toContain('    src/auth.test.ts');
    expect(byFile).toContain('matched by name');

    const bySymbol = await provider(repo).queryDependencies({ symbols: ['login'], files: [] });
    expect(bySymbol).toContain('symbol login');
    expect(bySymbol).toContain('src/app.ts: no matching declarations');

    const none = await provider(repo).queryDependencies({ symbols: ['zzzNotThere'], files: [] });
    expect(none).toContain('No tracked file declares the requested symbols');
    expect(await provider(repo).queryDependencies({ symbols: [], files: [] })).toContain(
      'No tracked file declares',
    );

    const failed = await provider(repo, {
      git: () => Promise.reject(new Error('x')),
    }).queryDependencies({ symbols: ['login'], files: [] });
    expect(failed).toContain('The repository search failed.');
    const capped = await provider(repo, { limits: { maxFilesParsed: 1 } }).queryDependencies({
      symbols: ['login'],
      files: [],
    });
    expect(capped).toContain('src/app.ts');
  });

  it('shows what was truncated and files that are unavailable', async () => {
    const repo = makeRepo(TS_FILES);
    const text = await provider(repo, { limits: { maxResultsPerSymbol: 1 } }).queryDependencies({
      symbols: ['login'],
      files: ['src/auth.ts', 'src/missing.ts'],
    });
    expect(text).toContain('[callers truncated at the per-symbol cap]');
    expect(text).toContain('src/missing.ts: unavailable (not-tracked)');
  });

  it('a trace probe is executed with callers as fenced data when the query is wired, and refused when it is not', async () => {
    const repo = makeRepo(TS_FILES);
    const prompts: string[] = [];
    const spawner: ProbeSpawner = {
      enforcesFileScope: { 'claude-code': true, codex: true },
      async spawnProbe(opts: ProbeSpawnOpts) {
        prompts.push(opts.prompt);
        return {
          status: 'success',
          output: JSON.stringify({
            observations: ['seen'],
            excerpts: [],
            commands: [],
            answer: { text: 'yes', confidence: 'high' },
          }),
        };
      },
    };
    const plan: ReviewPlan = {
      schemaVersion: 1,
      baselineVersion: '1',
      probes: [
        {
          id: 'tr1',
          type: 'trace',
          target: { symbols: ['login'], files: [{ path: 'src/auth.ts' }] },
          question: 'Who calls login?',
          covers: ['h1'],
        },
      ],
    };
    const limits: ExecutorLimits = { repoRoot: repo.dir, commandAllowlist: [] };

    const wired = await executePlan(plan, spawner, limits, {
      listAddedFiles: () => [],
      dependencyQuery: createTreeSitterDependencyQuery(),
    });
    expect(wired.entries[0]!.status).toBe('ok');
    expect(prompts[0]).toContain('dependency query result');
    expect(prompts[0]).toContain('src/app.ts#main');
    expect(prompts[0]).toContain('src/auth.ts#Session.start');

    prompts.length = 0;
    const unwired = await executePlan(plan, spawner, limits, { listAddedFiles: () => [] });
    expect(unwired.entries[0]).toMatchObject({
      status: 'refused',
      refusals: [{ reason: 'dependency-query-unavailable' }],
    });
    expect(prompts).toEqual([]);
  });
});

describe('buildRiskMap with the tree-sitter provider', () => {
  const diffFor = (start: number): string =>
    [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index 111..222 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      `@@ -${start},2 +${start},2 @@ export function login()`,
      '   audit(user);',
      '-  return hash(pw) === "y";',
      "+  return hash(pw) === 'x';",
      '',
    ].join('\n');

  it('attaches structural facts to hunks; without a provider the output is the default unavailable', async () => {
    const repo = makeRepo(TS_FILES);
    const out = join(repo.dir, '_artifacts');
    const withProvider = await buildRiskMap(diffFor(5), {
      structural: provider(repo),
      artifactsDir: out,
      runId: 'with',
    });
    const h = withProvider.map.hunks[0]!;
    expect(h.symbols).toEqual(['login']);
    expect(h.structural).toMatchObject({
      status: 'available',
      callers: ['src/app.ts#main', 'src/auth.ts#Session.start'],
      callees: ['src/audit.ts#audit', 'src/crypto.ts#hash'],
      referencingTests: ['src/auth.test.ts'],
    });

    const without = await buildRiskMap(diffFor(5), { artifactsDir: out, runId: 'without' });
    expect(without.map.hunks[0]!.structural).toEqual({ status: 'unavailable' });
    expect(without.map.hunks[0]!.riskScore).toBe(1);
  });
});
